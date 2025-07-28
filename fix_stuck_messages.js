import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new IORedis(process.env.REDIS_URL || '', {
  maxRetriesPerRequest: null,
  tls: {},
});

async function fixStuckMessages() {
  try {
    console.log('🔧 Arreglando mensajes stuck en Redis...\n');
    
    const locationId = 'fgK4QNPrkW9TsnxdOLjN';
    const streamName = `stream:location:${locationId}:workflow:b1961631-4fd8-4e89-beaa-1033bd13641b`;
    const consumerGroup = 'ghl-drip-workers';
    
    console.log(`📍 Stream objetivo: ${streamName}`);
    
    // 1. Verificar estado actual
    console.log('\n📊 Estado actual:');
    const streamLength = await redis.xlen(streamName);
    console.log(`  - Total mensajes en stream: ${streamLength}`);
    
    // 2. Verificar mensajes pendientes
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
    
    // 3. Limpiar mensajes pendientes stuck
    console.log('\n🧹 Limpiando mensajes pendientes...');
    try {
      // Obtener todos los mensajes pendientes
      const pendingDetails = await redis.xpending(streamName, consumerGroup, '-', '+', 100);
      
      for (const [messageId, consumer, idle, delivered] of pendingDetails) {
        const idleMinutes = Math.floor(idle / 60000);
        
        // Si el mensaje está idle por más de 1 hora, hacer ACK para liberarlo
        if (idle > 60 * 60 * 1000) { // 1 hora
          console.log(`  - Liberando mensaje ${messageId} (idle ${idleMinutes}min)`);
          await redis.xack(streamName, consumerGroup, messageId);
        } else {
          console.log(`  - Manteniendo mensaje ${messageId} (idle ${idleMinutes}min)`);
        }
      }
    } catch (error) {
      console.log(`  - Error limpiando pendientes: ${error.message}`);
    }
    
    // 4. Verificar si hay mensajes en el stream que necesitan ser procesados
    console.log('\n🔄 Verificando mensajes no procesados...');
    try {
      // Leer todos los mensajes del stream
      const messages = await redis.xrange(streamName, '-', '+');
      console.log(`  - Total mensajes en stream: ${messages.length}`);
      
      // Verificar cuáles no han sido procesados (no están en PEL)
      const processedMessages = new Set();
      try {
        const pendingDetails = await redis.xpending(streamName, consumerGroup, '-', '+', 1000);
        for (const [messageId] of pendingDetails) {
          processedMessages.add(messageId);
        }
      } catch (error) {
        // Si no hay grupo de consumidores, todos los mensajes están sin procesar
        console.log('  - No hay grupo de consumidores activo');
      }
      
      const unprocessedMessages = messages.filter(([id]) => !processedMessages.has(id));
      console.log(`  - Mensajes sin procesar: ${unprocessedMessages.length}`);
      
      if (unprocessedMessages.length > 0) {
        console.log('  - Los mensajes sin procesar serán procesados por el worker cuando se active el stream');
      }
    } catch (error) {
      console.log(`  - Error verificando mensajes: ${error.message}`);
    }
    
    // 5. Verificar estado final
    console.log('\n✅ Estado final:');
    const finalLength = await redis.xlen(streamName);
    console.log(`  - Total mensajes en stream: ${finalLength}`);
    
    try {
      const finalPending = await redis.xpending(streamName, consumerGroup);
      console.log(`  - Mensajes pendientes: ${finalPending[0]}`);
    } catch (error) {
      console.log(`  - Error verificando pendientes finales: ${error.message}`);
    }
    
    console.log('\n🎯 Próximos pasos:');
    console.log('  1. El worker debería detectar automáticamente el stream activo');
    console.log('  2. Los mensajes sin procesar serán procesados secuencialmente');
    console.log('  3. Verificar logs del worker para confirmar procesamiento');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await redis.disconnect();
  }
}

fixStuckMessages(); 