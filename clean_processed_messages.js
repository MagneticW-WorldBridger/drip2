import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new IORedis(process.env.REDIS_URL || '', {
  maxRetriesPerRequest: null,
  tls: {},
});

async function cleanProcessedMessages() {
  try {
    console.log('🧹 Limpiando mensajes procesados del stream...\n');
    
    const locationId = 'fgK4QNPrkW9TsnxdOLjN';
    const workflowId = 'b1961631-4fd8-4e89-beaa-1033bd13641b';
    const streamName = `stream:location:${locationId}:workflow:${workflowId}`;
    const consumerGroup = 'ghl-drip-workers';
    
    console.log(`📍 Stream objetivo: ${streamName}`);
    
    // 1. Verificar estado inicial
    console.log('\n📊 Estado inicial:');
    const initialLength = await redis.xlen(streamName);
    console.log(`  - Total mensajes en stream: ${initialLength}`);
    
    // 2. Obtener todos los mensajes del stream
    console.log('\n📝 Obteniendo todos los mensajes...');
    const allMessages = await redis.xrange(streamName, '-', '+');
    console.log(`  - Encontrados ${allMessages.length} mensajes`);
    
    // 3. Verificar cuáles están en PEL (pendientes)
    console.log('\n🔍 Verificando mensajes pendientes...');
    const pendingMessages = new Set();
    try {
      const pending = await redis.xpending(streamName, consumerGroup);
      if (pending[0] > 0) {
        const pendingDetails = await redis.xpending(streamName, consumerGroup, '-', '+', 1000);
        for (const [id] of pendingDetails) {
          pendingMessages.add(id);
        }
        console.log(`  - ${pendingMessages.size} mensajes pendientes`);
      } else {
        console.log('  - No hay mensajes pendientes');
      }
    } catch (error) {
      console.log(`  - Error verificando pendientes: ${error.message}`);
    }
    
    // 4. Identificar mensajes procesados (no están en PEL)
    const processedMessages = allMessages.filter(([id]) => !pendingMessages.has(id));
    console.log(`\n✅ Mensajes procesados: ${processedMessages.length}`);
    
    if (processedMessages.length === 0) {
      console.log('  - No hay mensajes procesados para limpiar');
      return;
    }
    
    // 5. Eliminar mensajes procesados
    console.log('\n🗑️ Eliminando mensajes procesados...');
    let deletedCount = 0;
    
    for (const [messageId, fields] of processedMessages) {
      try {
        // Convertir campos a objeto para mostrar información
        const messageData = {};
        for (let i = 0; i < fields.length; i += 2) {
          messageData[fields[i]] = fields[i + 1];
        }
        
        console.log(`  - Eliminando ${messageId} (contactId: ${messageData.contactId})`);
        
        // Eliminar el mensaje del stream
        await redis.xdel(streamName, messageId);
        deletedCount++;
        
      } catch (error) {
        console.log(`  - Error eliminando ${messageId}: ${error.message}`);
      }
    }
    
    // 6. Verificar estado final
    console.log('\n📊 Estado final:');
    const finalLength = await redis.xlen(streamName);
    console.log(`  - Total mensajes en stream: ${finalLength}`);
    console.log(`  - Mensajes eliminados: ${deletedCount}`);
    
    if (finalLength === 0) {
      console.log('\n🎉 ¡Stream completamente limpio!');
    } else {
      console.log(`\n⚠️  Quedan ${finalLength} mensajes en el stream`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await redis.disconnect();
  }
}

cleanProcessedMessages(); 