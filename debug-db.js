import { Pool } from 'pg';

const pool = new Pool({
  connectionString: "postgres://neondb_owner:npg_m0kqXGsYwj1T@ep-broad-field-a4y8u1l0-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false },
});

async function debugDatabase() {
  const client = await pool.connect();
  try {
    console.log('🔍 DEBUGGING DATABASE - FULL ANALYSIS\n');
    console.log('=' * 60);
    
    // 1. ¿Existe la tabla location_custom_fields?
    console.log('1️⃣ CHECKING IF TABLE EXISTS...');
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'location_custom_fields'
      );
    `);
    console.log('📋 location_custom_fields table exists:', tableExists.rows[0].exists);
    
    if (!tableExists.rows[0].exists) {
      console.log('❌ TABLE DOES NOT EXIST! Creating it...');
      await client.query(`
        CREATE TABLE location_custom_fields (
          location_id VARCHAR(255) PRIMARY KEY,
          timerdone_custom_field_id VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Table created successfully!');
      return;
    }
    
    console.log('\n2️⃣ TABLE SCHEMA:');
    const schema = await client.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'location_custom_fields'
      ORDER BY ordinal_position;
    `);
    console.table(schema.rows);
    
    console.log('\n3️⃣ ALL RECORDS IN TABLE:');
    const allRecords = await client.query('SELECT * FROM location_custom_fields ORDER BY created_at DESC');
    console.log(`Total records: ${allRecords.rows.length}`);
    if (allRecords.rows.length > 0) {
      console.table(allRecords.rows);
    } else {
      console.log('📭 Table is empty');
    }
    
    console.log('\n4️⃣ NULL VALUES CHECK:');
    const nullCount = await client.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(timerdone_custom_field_id) as non_null_custom_fields,
        COUNT(*) - COUNT(timerdone_custom_field_id) as null_custom_fields
      FROM location_custom_fields
    `);
    console.table(nullCount.rows);
    
    console.log('\n5️⃣ SPECIFIC LOCATION CHECK (LusFdDhrjmcz5fWAUIqm):');
    const specificLocation = await client.query(
      'SELECT * FROM location_custom_fields WHERE location_id = $1', 
      ['LusFdDhrjmcz5fWAUIqm']
    );
    if (specificLocation.rows.length > 0) {
      console.log('Found record for your location:');
      console.table(specificLocation.rows);
      
      const customFieldValue = specificLocation.rows[0].timerdone_custom_field_id;
      console.log(`Custom field value: "${customFieldValue}"`);
      console.log(`Custom field type: ${typeof customFieldValue}`);
      console.log(`Is null? ${customFieldValue === null}`);
      console.log(`Is undefined? ${customFieldValue === undefined}`);
      console.log(`Is empty string? ${customFieldValue === ''}`);
    } else {
      console.log('❌ NO RECORD found for location LusFdDhrjmcz5fWAUIqm');
    }
    
    console.log('\n6️⃣ RECENT sequential_queue RECORDS:');
    const recentQueue = await client.query(`
      SELECT contact_id, location_id, workflow_id, run_at, custom_field_id
      FROM sequential_queue 
      WHERE location_id = 'LusFdDhrjmcz5fWAUIqm'
      ORDER BY run_at DESC 
      LIMIT 5
    `);
    if (recentQueue.rows.length > 0) {
      console.table(recentQueue.rows);
    } else {
      console.log('📭 No recent queue records for your location');
    }
    
    console.log('\n7️⃣ CLEANUP RECOMMENDATIONS:');
    const nullRecords = await client.query('SELECT location_id FROM location_custom_fields WHERE timerdone_custom_field_id IS NULL');
    if (nullRecords.rows.length > 0) {
      console.log('⚠️  FOUND NULL RECORDS - these cause the bug!');
      console.log('Run this to fix:');
      console.log('DELETE FROM location_custom_fields WHERE timerdone_custom_field_id IS NULL;');
    } else {
      console.log('✅ No NULL records found');
    }
    
  } catch (error) {
    console.error('❌ DATABASE ERROR:', error.message);
    console.error('Full error:', error);
  } finally {
    client.release();
    await pool.end();
    console.log('\n🔚 Database connection closed');
  }
}

// Execute the debug
debugDatabase().catch(console.error); 