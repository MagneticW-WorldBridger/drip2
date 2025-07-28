import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new IORedis(process.env.REDIS_URL || '', {
  maxRetriesPerRequest: null,
  tls: {},
});

async function debugProcessing() {
  try {
    console.log('🔍 Debuggeando procesamiento de mensajes...\n');
    
    const locationId = 'fgK4QNPrkW9TsnxdOLjN';
    const workflowId = 'b1961631-4fd8-4e89-beaa-1033bd13641b';
    const streamName = `stream:location:${locationId}:workflow:${workflowId}`;
    const consumerGroup = 'ghl-drip-workers';
    
    console.log(`📍 Stream objetivo: ${streamName}`);
    
    // 1. Verificar mensajes pendientes
    console.log('\n📋 Verificando mensajes pendientes...');
    try {
      const pending = await redis.xpending(streamName, consumerGroup);
      console.log(`  - Mensajes pendientes: ${pending[0]}`);
      
      if (pending[0] > 0) {
        console.log('  - Detalles de pendientes:');
        const pendingDetails = await redis.xpending(streamName, consumerGroup, '-', '+', 10);
        for (const [id, consumer, idle, delivered] of pendingDetails) {
          const idleMinutes = Math.floor(idle / 60000);
          console.log(`    ${id}: consumer=${consumer}, idle=${idleMinutes}min, delivered=${delivered}`);
        }
      }
    } catch (error) {
      console.log(`  - Error verificando pendientes: ${error.message}`);
    }
    
    // 2. Intentar leer un mensaje manualmente para debuggear
    console.log('\n🔧 Intentando leer mensaje manualmente...');
    try {
      const messages = await redis.xreadgroup(
        'GROUP', consumerGroup, 'debug-consumer', 
        'COUNT', 1, 
        'BLOCK', 1000, 
        'STREAMS', streamName, '0'
      );
      
      if (messages && messages.length > 0) {
        const [stream] = messages;
        const [_, messageArray] = stream;
        
        if (messageArray && messageArray.length > 0) {
          const [messageId, fields] = messageArray[0];
          
          console.log(`  ✅ Mensaje leído: ${messageId}`);
          
          // Convertir campos a objeto
          const messageData = {};
          for (let i = 0; i < fields.length; i += 2) {
            messageData[fields[i]] = fields[i + 1];
          }
          
          console.log('  📝 Datos del mensaje:');
          console.log(`    - contactId: ${messageData.contactId}`);
          console.log(`    - locationId: ${messageData.locationId}`);
          console.log(`    - workflowId: ${messageData.workflowId}`);
          console.log(`    - customFieldId: ${messageData.customFieldId}`);
          console.log(`    - apiKey: ${messageData.apiKey ? 'EXISTS' : 'MISSING'}`);
          console.log(`    - runAt: ${messageData.runAt}`);
          
          // Verificar si el runAt ya pasó
          const runAt = new Date(messageData.runAt);
          const now = new Date();
          const timeDiff = now.getTime() - runAt.getTime();
          const timeDiffMinutes = Math.floor(timeDiff / 60000);
          
          console.log(`    - runAt vs ahora: ${timeDiffMinutes} minutos de diferencia`);
          
          if (timeDiff < 0) {
            console.log('    ⚠️  El mensaje aún no debería ejecutarse');
          } else {
            console.log('    ✅ El mensaje debería ejecutarse ahora');
          }
          
          // Hacer ACK para liberar el mensaje
          await redis.xack(streamName, consumerGroup, messageId);
          console.log(`  ✅ ACK realizado para ${messageId}`);
          
        } else {
          console.log('  ❌ No se pudieron leer mensajes');
        }
      } else {
        console.log('  ❌ No hay mensajes disponibles para leer');
      }
    } catch (error) {
      console.log(`  ❌ Error leyendo mensaje: ${error.message}`);
    }
    
    // 3. Verificar estado final
    console.log('\n📊 Estado final:');
    const finalLength = await redis.xlen(streamName);
    console.log(`  - Total mensajes en stream: ${finalLength}`);
    
    try {
      const finalPending = await redis.xpending(streamName, consumerGroup);
      console.log(`  - Mensajes pendientes: ${finalPending[0]}`);
    } catch (error) {
      console.log(`  - Error verificando pendientes finales: ${error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await redis.disconnect();
  }
}

debugProcessing(); 