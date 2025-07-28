import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new IORedis(process.env.REDIS_URL || '', {
  maxRetriesPerRequest: null,
  tls: {},
});

async function checkRedisStatus() {
  try {
    console.log('🔍 Verificando estado de Redis...\n');
    
    // Verificar conexión
    await redis.ping();
    console.log('✅ Conexión a Redis exitosa\n');
    
    // Buscar streams relacionados con el location específico
    const locationId = 'fgK4QNPrkW9TsnxdOLjN';
    const pattern = `stream:location:${locationId}:*`;
    
    console.log(`🔍 Buscando streams para location: ${locationId}`);
    const keys = await redis.keys(pattern);
    
    if (keys.length === 0) {
      console.log('❌ No se encontraron streams para este location');
    } else {
      console.log(`✅ Encontrados ${keys.length} streams:`);
      
      for (const key of keys) {
        const length = await redis.xlen(key);
        console.log(`  - ${key}: ${length} mensajes`);
        
        if (length > 0) {
          // Mostrar los últimos mensajes
          const messages = await redis.xrange(key, '-', '+', 'COUNT', 5);
          console.log(`    Últimos mensajes:`);
          for (const [id, fields] of messages) {
            console.log(`      ${id}: ${JSON.stringify(fields)}`);
          }
        }
      }
    }
    
    // Verificar grupos de consumidores
    console.log('\n🔍 Verificando grupos de consumidores...');
    for (const key of keys) {
      try {
        const groups = await redis.xinfo('GROUPS', key);
        console.log(`  ${key}:`);
        for (const group of groups) {
          console.log(`    - Grupo: ${group[1]}, Consumidores: ${group[3]}, Pendientes: ${group[5]}`);
        }
      } catch (error) {
        console.log(`    ❌ Error obteniendo info del grupo: ${error.message}`);
      }
    }
    
    // Verificar mensajes pendientes (PEL)
    console.log('\n🔍 Verificando mensajes pendientes...');
    for (const key of keys) {
      try {
        const pending = await redis.xpending(key, 'ghl-drip-workers');
        console.log(`  ${key}: ${pending[0]} mensajes pendientes`);
        
        if (pending[0] > 0) {
          const pendingDetails = await redis.xpending(key, 'ghl-drip-workers', '-', '+', 10);
          console.log('    Detalles de pendientes:');
          for (const [id, consumer, idle, delivered] of pendingDetails) {
            console.log(`      ${id}: consumer=${consumer}, idle=${idle}ms, delivered=${delivered}`);
          }
        }
      } catch (error) {
        console.log(`    ❌ Error verificando pendientes: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await redis.disconnect();
  }
}

checkRedisStatus(); 