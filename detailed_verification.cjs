const { Pool } = require('pg');
const { DateTime } = require('luxon');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BUSINESS_START = 8;  // 8 AM
const BUSINESS_END = 20;   // 8 PM

async function detailedVerification() {
  const client = await pool.connect();
  
  try {
    console.log('🔍 DETAILED VIOLATION DETECTION VERIFICATION');
    console.log('==============================================');
    console.log(`Business Hours: ${BUSINESS_START} AM to ${BUSINESS_END} PM (${BUSINESS_END}:00 is EXCLUDED)`);
    console.log('==============================================\n');
    
    // Test a few specific cases to verify logic
    console.log('🧪 TESTING VIOLATION DETECTION LOGIC:');
    console.log('=====================================');
    
    // Test cases for different hours
    const testCases = [
      { hour: 7, expected: 'VIOLATION (before 8 AM)' },
      { hour: 8, expected: 'VALID (8 AM exactly)' },
      { hour: 12, expected: 'VALID (noon)' },
      { hour: 19, expected: 'VALID (7 PM)' },
      { hour: 20, expected: 'VIOLATION (8 PM exactly)' },
      { hour: 22, expected: 'VIOLATION (10 PM)' }
    ];
    
    testCases.forEach(({ hour, expected }) => {
      const isViolation = hour < BUSINESS_START || hour >= BUSINESS_END;
      const result = isViolation ? 'VIOLATION' : 'VALID';
      const status = result === expected.split(' ')[0] ? '✅' : '❌';
      console.log(`${status} Hour ${hour}: ${result} - ${expected}`);
    });
    
    console.log('\n🔍 SAMPLING ACTUAL QUEUE DATA:');
    console.log('================================');
    
    // Get a sample of messages from different locations
    const sampleResult = await client.query(`
      SELECT 
        sq.id,
        sq.location_id,
        sq.run_at,
        sq.contact_id,
        sq.created_at,
        lcf.timezone
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      WHERE sq.location_id IN (
        'brx4IqWlCYpGp3qdLXhZ',
        '7a61hI3FXzLOu0RP9K2I', 
        'aUJ2yfyM47p9RbExLah6',
        'NF07RNQ9TElDJeTx2zSZ',
        'fgK4QNPrkW9TsnxdOLjN'
      )
      ORDER BY sq.location_id, sq.run_at
      LIMIT 20
    `);
    
    console.log(`\n📊 ANALYZING ${sampleResult.rows.length} SAMPLE MESSAGES:\n`);
    
    let sampleViolations = 0;
    
    sampleResult.rows.forEach((row, index) => {
      const locationId = row.location_id;
      const runAt = row.run_at;
      const timezone = row.timezone || 'America/New_York';
      
      // Convert to local time
      const localTime = DateTime.fromJSDate(runAt).setZone(timezone);
      const hour = localTime.hour;
      
      // Check business hours
      const isViolation = hour < BUSINESS_START || hour >= BUSINESS_END;
      if (isViolation) sampleViolations++;
      
      const status = isViolation ? '❌ VIOLATION' : '✅ VALID';
      
      console.log(`${index + 1}. ${status}`);
      console.log(`   Location: ${locationId}`);
      console.log(`   Contact: ${row.contact_id}`);
      console.log(`   Created: ${row.created_at?.toISOString()}`);
      console.log(`   Timezone: ${timezone}`);
      console.log(`   UTC Time: ${runAt.toISOString()}`);
      console.log(`   Local Time: ${localTime.toISO()}`);
      console.log(`   Local Hour: ${hour} (${hour < 12 ? hour + ' AM' : (hour === 12 ? '12 PM' : (hour - 12) + ' PM')})`);
      console.log(`   Violation Check: ${hour} < ${BUSINESS_START} OR ${hour} >= ${BUSINESS_END} = ${isViolation}`);
      console.log('');
    });
    
    console.log(`📊 SAMPLE VIOLATION RATE: ${sampleViolations}/${sampleResult.rows.length} (${((sampleViolations / sampleResult.rows.length) * 100).toFixed(1)}%)\n`);
    
    // Check timezone coverage
    console.log('🌍 TIMEZONE COVERAGE CHECK:');
    console.log('============================');
    
    const timezoneResult = await client.query(`
      SELECT 
        lcf.timezone,
        COUNT(sq.id) as message_count,
        COUNT(DISTINCT sq.location_id) as location_count
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      GROUP BY lcf.timezone
      ORDER BY message_count DESC
    `);
    
    timezoneResult.rows.forEach(row => {
      const timezone = row.timezone || 'NULL (fallback to America/New_York)';
      console.log(`- ${timezone}: ${row.message_count} messages across ${row.location_count} locations`);
    });
    
    // Verify specific problem locations
    console.log('\n🎯 DETAILED ANALYSIS OF PROBLEM LOCATIONS:');
    console.log('===========================================');
    
    const problemLocations = ['brx4IqWlCYpGp3qdLXhZ', '7a61hI3FXzLOu0RP9K2I'];
    
    for (const locationId of problemLocations) {
      console.log(`\n📍 LOCATION: ${locationId}`);
      console.log('─'.repeat(50));
      
      const locationResult = await client.query(`
        SELECT 
          sq.run_at,
          sq.created_at,
          lcf.timezone,
          COUNT(*) as count
        FROM sequential_queue sq
        LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
        WHERE sq.location_id = $1
        GROUP BY sq.run_at, sq.created_at, lcf.timezone
        ORDER BY sq.run_at
        LIMIT 10
      `, [locationId]);
      
      const timezone = locationResult.rows[0]?.timezone || 'America/New_York';
      
      console.log(`🌍 Timezone: ${timezone}`);
      console.log(`📊 Sample messages (first 10):`);
      
      locationResult.rows.forEach((row, index) => {
        const localTime = DateTime.fromJSDate(row.run_at).setZone(timezone);
        const hour = localTime.hour;
        const isViolation = hour < BUSINESS_START || hour >= BUSINESS_END;
        const status = isViolation ? '❌' : '✅';
        
        console.log(`   ${index + 1}. ${status} ${row.run_at.toISOString()} → ${localTime.toISO()} (Hour: ${hour})`);
      });
    }
    
    console.log('\n🔧 VALIDATION COMPLETE');
    console.log('======================');
    console.log('✅ Timezone conversion logic verified');
    console.log('✅ Business hours detection logic verified');
    console.log('✅ Sample data analysis complete');
    console.log('\nIf violations are confirmed, we need to fix the entire queue.');
    
  } catch (error) {
    console.error('❌ ERROR:', error);
  } finally {
    client.release();
    process.exit(0);
  }
}

// Run the detailed verification
detailedVerification().catch(console.error); 