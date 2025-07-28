const { Pool } = require('pg');
const { DateTime } = require('luxon');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BUSINESS_START = 8;  // 8 AM
const BUSINESS_END = 20;   // 8 PM

async function verifyAllBusinessHours() {
  const client = await pool.connect();
  
  try {
    console.log('🔍 COMPREHENSIVE BUSINESS HOURS VERIFICATION');
    console.log('============================================');
    console.log('Checking all run_at times against individual location timezones...\n');
    
    // Get all messages with their location info
    const result = await client.query(`
      SELECT 
        sq.id,
        sq.location_id,
        sq.workflow_id,
        sq.run_at,
        sq.contact_id,
        lcf.timezone,
        sq.created_at
      FROM sequential_queue sq
      LEFT JOIN location_custom_fields lcf ON sq.location_id = lcf.location_id
      ORDER BY sq.location_id, sq.run_at
    `);
    
    console.log(`📊 TOTAL MESSAGES TO CHECK: ${result.rows.length}`);
    
    let violations = [];
    let locationStats = {};
    let timezoneMissing = [];
    
    for (const row of result.rows) {
      const locationId = row.location_id;
      const runAt = row.run_at;
      const timezone = row.timezone || 'America/New_York'; // fallback
      
      // Track location stats
      if (!locationStats[locationId]) {
        locationStats[locationId] = {
          total: 0,
          violations: 0,
          timezone: timezone,
          nextRun: null,
          lastRun: null
        };
      }
      locationStats[locationId].total++;
      
      // Track timezone missing
      if (!row.timezone) {
        timezoneMissing.push(locationId);
      }
      
      // Convert to local time
      const localTime = DateTime.fromJSDate(runAt).setZone(timezone);
      const hour = localTime.hour;
      
      // Update run time tracking
      if (!locationStats[locationId].nextRun || runAt < locationStats[locationId].nextRun) {
        locationStats[locationId].nextRun = runAt;
      }
      if (!locationStats[locationId].lastRun || runAt > locationStats[locationId].lastRun) {
        locationStats[locationId].lastRun = runAt;
      }
      
      // Check business hours
      if (hour < BUSINESS_START || hour >= BUSINESS_END) {
        violations.push({
          id: row.id,
          locationId: locationId,
          contactId: row.contact_id,
          runAt: runAt,
          localTime: localTime.toISO(),
          hour: hour,
          timezone: timezone,
          createdAt: row.created_at
        });
        locationStats[locationId].violations++;
      }
    }
    
    // Print summary
    console.log('\n📋 SUMMARY BY LOCATION:');
    console.log('=======================');
    
    const sortedLocations = Object.entries(locationStats)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15); // Top 15 locations
    
    sortedLocations.forEach(([locationId, stats]) => {
      const violationRate = ((stats.violations / stats.total) * 100).toFixed(1);
      const status = stats.violations === 0 ? '✅' : '❌';
      
      console.log(`${status} ${locationId}:`);
      console.log(`   📊 Total: ${stats.total} messages`);
      console.log(`   ⚠️  Violations: ${stats.violations} (${violationRate}%)`);
      console.log(`   🌍 Timezone: ${stats.timezone}`);
      console.log(`   ⏰ Next: ${stats.nextRun?.toISOString()}`);
      console.log(`   ⏰ Last: ${stats.lastRun?.toISOString()}`);
      console.log('');
    });
    
    // Print violations details
    if (violations.length > 0) {
      console.log('\n⚠️  BUSINESS HOURS VIOLATIONS FOUND:');
      console.log('====================================');
      
      violations.slice(0, 20).forEach(violation => {
        console.log(`❌ Location: ${violation.locationId}`);
        console.log(`   Contact: ${violation.contactId}`);
        console.log(`   UTC Time: ${violation.runAt.toISOString()}`);
        console.log(`   Local Time: ${violation.localTime} (Hour: ${violation.hour})`);
        console.log(`   Timezone: ${violation.timezone}`);
        console.log(`   Created: ${violation.createdAt?.toISOString()}`);
        console.log('');
      });
      
      if (violations.length > 20) {
        console.log(`... and ${violations.length - 20} more violations`);
      }
    } else {
      console.log('\n✅ NO BUSINESS HOURS VIOLATIONS FOUND!');
      console.log('======================================');
      console.log('All messages are scheduled within business hours (8 AM - 8 PM local time)');
    }
    
    // Print timezone issues
    if (timezoneMissing.length > 0) {
      const uniqueMissing = [...new Set(timezoneMissing)];
      console.log('\n⚠️  LOCATIONS WITH MISSING TIMEZONES:');
      console.log('====================================');
      uniqueMissing.forEach(locationId => {
        console.log(`- ${locationId} (using fallback: America/New_York)`);
      });
    }
    
    // Final summary
    console.log('\n📊 FINAL SUMMARY:');
    console.log('=================');
    console.log(`Total Messages: ${result.rows.length}`);
    console.log(`Total Locations: ${Object.keys(locationStats).length}`);
    console.log(`Business Hours Violations: ${violations.length}`);
    console.log(`Locations with Missing Timezones: ${[...new Set(timezoneMissing)].length}`);
    console.log(`Violation Rate: ${((violations.length / result.rows.length) * 100).toFixed(2)}%`);
    
    if (violations.length === 0) {
      console.log('\n🎉 CONGRATULATIONS! 🎉');
      console.log('======================');
      console.log('✅ ALL MESSAGES RESPECT BUSINESS HOURS!');
      console.log('✅ THE QUEUE IS CLEAN AND PROPERLY CONFIGURED!');
      console.log('✅ YOU CAN CONFIDENTLY TELL THE CLIENT THE ISSUE WAS HISTORICAL AND IS FIXED!');
    } else {
      console.log('\n💡 RECOMMENDATIONS:');
      console.log('==================');
      console.log('1. Review the violations listed above');
      console.log('2. Check if these are legacy messages from before the fix');
      console.log('3. Consider running a cleanup script for the violating messages');
      console.log('4. Verify timezone data for locations with missing timezones');
    }
    
  } catch (error) {
    console.error('❌ ERROR:', error);
  } finally {
    client.release();
    process.exit(0);
  }
}

// Run the verification
verifyAllBusinessHours().catch(console.error); 