import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new IORedis(process.env.REDIS_URL || '', {
  maxRetriesPerRequest: null,
  tls: {},
});

async function forceActivateStream() {
  try {
    console.log('🚀 Forzando activación del stream...\n');
    
    const locationId = 'fgK4QNPrkW9TsnxdOLjN';
    const workflowId = 'b1961631-4fd8-4e89-beaa-1033bd13641b';
    const streamName = `stream:location:${locationId}:workflow:${workflowId}`;
    const consumerGroup = 'ghl-drip-workers';
    
    console.log(`📍 Stream objetivo: ${streamName}`);
    
    // 1. Verificar que el stream existe y tiene mensajes
    const streamLength = await redis.xlen(streamName);
    console.log(`📊 Mensajes en stream: ${streamLength}`);
    
    if (streamLength === 0) {
      console.log('❌ No hay mensajes en el stream para procesar');
      return;
    }
    
    // 2. Crear el grupo de consumidores si no existe
    console.log('\n🔧 Creando grupo de consumidores...');
    try {
      await redis.xgroup('CREATE', streamName, consumerGroup, '0', 'MKSTREAM');
      console.log('✅ Grupo de consumidores creado');
    } catch (error) {
      if (error.message.includes('BUSYGROUP')) {
        console.log('✅ Grupo de consumidores ya existe');
      } else {
        console.log(`❌ Error creando grupo: ${error.message}`);
        return;
      }
    }
    
    // 3. Verificar que el grupo se creó correctamente
    console.log('\n🔍 Verificando grupo de consumidores...');
    try {
      const groups = await redis.xinfo('GROUPS', streamName);
      console.log('✅ Información del grupo:');
      for (const group of groups) {
        console.log(`  - Grupo: ${group[1]}, Consumidores: ${group[3]}, Pendientes: ${group[5]}`);
      }
    } catch (error) {
      console.log(`❌ Error obteniendo info del grupo: ${error.message}`);
    }
    
    // 4. Verificar mensajes pendientes
    console.log('\n📋 Verificando mensajes pendientes...');
    try {
      const pending = await redis.xpending(streamName, consumerGroup);
      console.log(`  - Mensajes pendientes: ${pending[0]}`);
      
      if (pending[0] > 0) {
        console.log('  - Detalles de pendientes:');
        const pendingDetails = await redis.xpending(streamName, consumerGroup, '-', '+', 5);
        for (const [id, consumer, idle, delivered] of pendingDetails) {
          const idleMinutes = Math.floor(idle / 60000);
          console.log(`    ${id}: consumer=${consumer}, idle=${idleMinutes}min, delivered=${delivered}`);
        }
      }
    } catch (error) {
      console.log(`  - Error verificando pendientes: ${error.message}`);
    }
    
    // 5. Mostrar los primeros mensajes del stream
    console.log('\n📝 Primeros mensajes del stream:');
    const messages = await redis.xrange(streamName, '-', '+', 'COUNT', 3);
    for (const [id, fields] of messages) {
      // Convertir campos a objeto para mejor legibilidad
      const messageData = {};
      for (let i = 0; i < fields.length; i += 2) {
        messageData[fields[i]] = fields[i + 1];
      }
      console.log(`  ${id}: contactId=${messageData.contactId}, runAt=${messageData.runAt}`);
    }
    
    console.log('\n✅ Stream activado y listo para procesamiento');
    console.log('🎯 El worker debería comenzar a procesar los mensajes automáticamente');
    console.log('📊 Monitorea los logs del worker para ver el progreso');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await redis.disconnect();
  }
}

forceActivateStream(); 