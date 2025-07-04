import { redisClient, createConsumerGroup, getStreamName } from './api/queue.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import * as crypto from 'crypto';
import nodemailer from 'nodemailer';

dotenv.config();

// 🚨 SISTEMA DE ALERTAS PARA ERRORES 401
const errorTracker = new Map<string, { count: number; lastReset: number }>();
const ALERT_THRESHOLD = 5; // 5 errores 401 del mismo location
const RESET_INTERVAL = 10 * 60 * 1000; // 10 minutos

// Configurar nodemailer (usar Gmail como ejemplo)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ALERT_EMAIL_USER, // tu-email@gmail.com
    pass: process.env.ALERT_EMAIL_PASS  // tu-app-password
  }
});

async function sendAlert(locationId: string, errorCount: number) {
  try {
    const mailOptions = {
      from: process.env.ALERT_EMAIL_USER,
      to: process.env.ADMIN_EMAILS, // 'admin1@company.com,admin2@company.com'
      subject: `🚨 ALERTA: API Key Inválida - Location ${locationId}`,
      html: `
        <h2>🚨 ALERTA CRÍTICA - GHL DRIP SYSTEM</h2>
        <p><strong>Location ID:</strong> ${locationId}</p>
        <p><strong>Errores 401 detectados:</strong> ${errorCount}</p>
        <p><strong>Causa:</strong> API Key inválida o expirada</p>
        <p><strong>Acción requerida:</strong> Verificar y actualizar API Key para este location</p>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <hr>
        <p><small>Este mensaje fue enviado automáticamente por el sistema de monitoreo.</small></p>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Alerta enviada para location ${locationId}`);
  } catch (error) {
    console.error(`❌ Error enviando alerta:`, error);
  }
}

function trackError(locationId: string) {
  const now = Date.now();
  const key = locationId;
  
  if (!errorTracker.has(key)) {
    errorTracker.set(key, { count: 0, lastReset: now });
  }
  
  const tracker = errorTracker.get(key)!;
  
  // Reset contador si han pasado 10 minutos
  if (now - tracker.lastReset > RESET_INTERVAL) {
    tracker.count = 0;
    tracker.lastReset = now;
  }
  
  tracker.count++;
  
  // Enviar alerta si se alcanza el threshold
  if (tracker.count === ALERT_THRESHOLD) {
    sendAlert(locationId, tracker.count);
    // Reset para evitar spam de emails
    tracker.count = 0;
    tracker.lastReset = now;
  }
}

// Generamos un ID único para este worker
const WORKER_ID = process.env.WORKER_ID || `worker-${crypto.randomBytes(4).toString('hex')}`;
console.log(`🆔 Worker ID: ${WORKER_ID}`);

// Nombre del grupo de consumidores (compartido por todos los workers)
const CONSUMER_GROUP = 'ghl-drip-workers';

// Conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Administrador de streams - mantiene estados y optimiza recursos
class StreamManager {
  // Mapa de streams activos (siendo procesados actualmente)
  private activeStreams = new Map<string, boolean>();
  
  // Mapa de estados de cada stream (métricas y contadores)
  private streamStatus = new Map<string, {
    lastActivity: number;    // Timestamp de última actividad
    emptyChecks: number;     // Conteo de verificaciones vacías consecutivas
  }>();
  
  // Tiempo máximo de inactividad (5 minutos)
  private MAX_INACTIVITY_MS = 5 * 60 * 1000;
  
  // Checks vacíos antes de liberar (30 checks = ~1 minuto con 2 seg de BLOCK)
  private MAX_EMPTY_CHECKS = 30;
  
  /**
   * Activa un stream para procesamiento
   * @param streamName Nombre del stream a activar
   */
  async activateStream(streamName: string): Promise<boolean> {
    // Si ya está activo, no hacer nada
    if (this.activeStreams.has(streamName)) {
      return true;
    }
    
    try {
      // Crear consumer group (con MKSTREAM)
      const created = await createConsumerGroup(streamName, CONSUMER_GROUP);
      if (!created) return false;
      
      // Marcar como activo
      this.activeStreams.set(streamName, true);
      this.streamStatus.set(streamName, {
        lastActivity: Date.now(),
        emptyChecks: 0
      });
      
      console.log(`🟢 Stream ${streamName} activado`);
      
      // Iniciar procesamiento en background
      this.startProcessing(streamName);
      
      return true;
    } catch (error) {
      console.error(`Error activando stream ${streamName}:`, error);
      return false;
    }
  }
  
  /**
   * Desactiva un stream, liberando recursos
   * @param streamName Nombre del stream a desactivar
   */
  deactivateStream(streamName: string): void {
    if (this.activeStreams.has(streamName)) {
      this.activeStreams.delete(streamName);
      this.streamStatus.delete(streamName);
      console.log(`🔴 Stream ${streamName} desactivado por inactividad`);
    }
  }
  
  /**
   * Inicia el procesamiento continuo de un stream en background
   * @param streamName Nombre del stream a procesar
   */
  private startProcessing(streamName: string): void {
    // No bloquear, ejecutar en background
    (async () => {
      const status = this.streamStatus.get(streamName);
      if (!status) return; // Safety check
      
      // Bucle de procesamiento continuo mientras el stream esté activo
      while (this.activeStreams.has(streamName)) {
        try {
          // Leer mensajes nuevos del stream
          const messages = await redisClient.xreadgroup(
            'GROUP', CONSUMER_GROUP, WORKER_ID, 
            'COUNT', 1, // Procesar de uno en uno para garantizar orden
            'BLOCK', 2000, // Bloquear 2 segundos, luego comprobar estado
            'STREAMS', streamName, '>'
          );
          
          // Si hay mensajes nuevos, procesarlos
          if (messages && messages.length > 0) {
            const [stream] = messages;
            const [_, messageArray] = stream as [string, any[]];
            
            if (messageArray && messageArray.length > 0) {
              const [messageId, fields] = messageArray[0] as [string, string[]];
              
              // Convertir el array de campos a un objeto
              const messageData: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                messageData[fields[i]] = fields[i + 1];
              }
              
              // Procesar mensaje
              await processStreamMessage(streamName, messageId, messageData);
              
              // Actualizar métricas - actividad reciente
              status.lastActivity = Date.now();
              status.emptyChecks = 0;
              continue; // Continuar inmediatamente al siguiente mensaje
            }
          }
          
          // No hay mensajes nuevos, verificar mensajes pendientes
          try {
            // Aquí iría el código existente para procesar pendientes...
            // [Se omite por brevedad]
            
            // Incrementar contador de verificaciones vacías
            status.emptyChecks++;
            
            // Si llevamos muchas verificaciones sin mensajes, revisar inactividad
            if (status.emptyChecks >= this.MAX_EMPTY_CHECKS) {
              const inactivityTime = Date.now() - status.lastActivity;
              
              // Si ha pasado mucho tiempo desde la última actividad, desactivar
              if (inactivityTime > this.MAX_INACTIVITY_MS) {
                console.log(`💤 Stream ${streamName} inactivo por ${Math.floor(inactivityTime/1000)}s, liberando recursos`);
                this.deactivateStream(streamName);
                break; // Salir del bucle while
              }
            }
          } catch (pendingError) {
            console.error(`❌ Error verificando pendientes en ${streamName}:`, pendingError);
          }
        } catch (error: any) {
          // Errores de procesamiento
          if (error.message?.includes('NOGROUP')) {
            console.log(`🚫 Stream ${streamName} no existe, desactivando`);
            this.deactivateStream(streamName);
            break;
          } else {
            console.error(`❌ Error procesando stream ${streamName}:`, error);
            // Esperar un segundo antes de reintentar
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } // fin del while
    })().catch(error => {
      console.error(`❗ Error fatal en procesamiento de ${streamName}:`, error);
      this.deactivateStream(streamName);
    });
  }
  
  /**
   * Busca streams que deberían estar activos según Postgres
   */
  async discoverActiveStreams(): Promise<void> {
    const client = await pool.connect();
    try {
      // SOLO buscar streams que tendrán actividad PRONTO
      const result = await client.query(
        `SELECT DISTINCT location_id, workflow_id 
         FROM sequential_queue 
         WHERE run_at <= NOW() + INTERVAL '1 minute'
         LIMIT 100`
      );
      
      // Activar streams para cada combinación
      for (const row of result.rows) {
        const streamName = getStreamName(row.location_id, row.workflow_id);
        this.activateStream(streamName);
      }
      
      // Log conservador (solo si hay streams activos)
      if (this.activeStreams.size > 0) {
        console.log(`🔄 Procesando ${this.activeStreams.size} streams actualmente`);
      }
    } catch (error) {
      console.error('❌ Error buscando streams activos:', error);
    } finally {
      client.release();
    }
  }
  
  /**
   * Obtiene la lista de streams activos
   */
  getActiveStreams(): string[] {
    return Array.from(this.activeStreams.keys());
  }
}

// Crear instancia del administrador de streams
const streamManager = new StreamManager();

// Función para llamar a GHL y actualizar contacto
async function updateContact(contactId: string, locationId: string, customFieldId: string, apiKey: string) {
  console.log(`🔔 Actualizando contacto ${contactId}`);
  
  const res = await fetch(
    `https://rest.gohighlevel.com/v1/contacts/${contactId}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,  // Usar la API key específica del contacto
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        customField: {
          [customFieldId]: "YES"
        }
      })
    }
  );
  
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`❌ Falló GHL (${res.status}): ${body}`);
  }
  
  console.log(`✅ Contacto ${contactId} actualizado`);
}

// Función para borrar el contacto de la tabla de PostgreSQL
async function removeFromQueue(contactId: string, locationId: string, workflowId: string = 'noworkflow') {
  const client = await pool.connect();
  try {
    await client.query(
      `DELETE FROM sequential_queue
       WHERE contact_id = $1 AND location_id = $2 AND workflow_id = $3`,
      [contactId, locationId, workflowId || 'noworkflow']
    );
    console.log(`🗑️ Contacto ${contactId} borrado de sequential_queue`);
  } finally {
    client.release();
  }
}

// Función para procesar un mensaje de un stream
async function processStreamMessage(
  streamName: string, 
  messageId: string, 
  messageData: Record<string, string>
) {
  let shouldAck = true; // SIEMPRE hacer ACK por defecto
  
  try {
    console.log(`⚙️ Procesando mensaje ${messageId} del stream ${streamName}`);
    
    // Extraer datos del mensaje
    const contactId = messageData.contactId;
    const locationId = messageData.locationId;
    const workflowId = messageData.workflowId || 'noworkflow';
    const customFieldId = messageData.customFieldId;
    const apiKey = messageData.apiKey;  // Extraer API key del mensaje
    
    // Validar datos requeridos
    if (!contactId || !locationId || !customFieldId || !apiKey) {
      console.error(`❌ Datos incompletos en mensaje ${messageId}:`, messageData);
      // ACK mensaje malformado para evitar reprocessing infinito
      await redisClient.xack(streamName, CONSUMER_GROUP, messageId);
      await redisClient.xdel(streamName, messageId);
      return;
    }
    
    console.log(`🔔 Actualizando contacto ${contactId}`);
    
    // Intentar actualizar el contacto
    try {
      await updateContact(contactId, locationId, customFieldId, apiKey);
      console.log(`✅ Contacto ${contactId} actualizado`);
    } catch (updateError: any) {
      console.error(`❌ Error actualizando contacto ${contactId}:`, updateError.message);
      
      // CRÍTICO: Si es error 401, hacer ACK para evitar PEL overflow
      if (updateError.message.includes('401') || updateError.message.includes('Api key is invalid')) {
        console.error(`🚨 API KEY INVÁLIDA para location ${locationId} - HACIENDO ACK para evitar PEL overflow`);
        
        // 🚨 SISTEMA DE ALERTAS: Trackear error 401
        trackError(locationId);
        
        // Continuar con ACK y eliminación
      } else {
        // Para otros errores, también hacer ACK para evitar loops infinitos
        console.error(`🚨 Error no-401 - HACIENDO ACK para evitar loops infinitos`);
      }
    }
    
    // Intentar remover de PostgreSQL
    try {
      await removeFromQueue(contactId, locationId, workflowId);
      console.log(`🗑️ Contacto ${contactId} borrado de sequential_queue`);
    } catch (removeError: any) {
      console.error(`❌ Error removiendo de queue:`, removeError.message);
      // Continuar con ACK incluso si falla la remoción
    }
    
  } catch (error: any) {
    console.error(`❌ Error procesando mensaje ${messageId}:`, error);
    // SIEMPRE hacer ACK incluso en errores inesperados
  }
  
  // CRÍTICO: SIEMPRE hacer ACK y DELETE para evitar PEL overflow
  try {
    await redisClient.xack(streamName, CONSUMER_GROUP, messageId);
    await redisClient.xdel(streamName, messageId);
    console.log(`✅ Mensaje ${messageId} procesado correctamente`);
  } catch (ackError: any) {
    console.error(`❌ Error haciendo ACK del mensaje ${messageId}:`, ackError);
    // Incluso si falla el ACK, loggear para debugging
  }
}

// Iniciar bucle de descubrimiento de streams
async function runDiscoveryLoop() {
  try {
    await streamManager.discoverActiveStreams();
  } catch (error) {
    console.error('Error en bucle de descubrimiento:', error);
  }
  
  // Programar próxima ejecución (cada 15 segundos)
  setTimeout(runDiscoveryLoop, 15000);
}

// Iniciar worker
console.log('🚀 Worker iniciando...');
runDiscoveryLoop().catch(error => {
  console.error('❌ Error fatal en worker:', error);
  process.exit(1);
});

// Manejar señales para una limpieza adecuada
process.on('SIGINT', () => {
  console.log('👋 Cerrando worker...');
  redisClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('👋 Cerrando worker...');
  redisClient.disconnect();
  process.exit(0);
});