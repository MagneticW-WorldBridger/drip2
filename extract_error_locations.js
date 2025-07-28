import fs from 'fs';

// Read the logs file
const logsData = fs.readFileSync('logs_result-6.json', 'utf8');
const logs = JSON.parse(logsData);

// Set to store unique location IDs with errors
const errorLocationIds = new Set();
const errorDetails = [];

// Process each log entry
logs.forEach(log => {
  // Check if this log contains a MISSING DATA ERROR
  if (log.message && log.message.includes('❌ MISSING DATA ERROR')) {
    // Find the corresponding locationId log entry
    // Look for the locationId log entry that belongs to the same request
    const requestId = log.requestId;
    const locationIdLog = logs.find(l => 
      l.requestId === requestId && 
      l.message && 
      l.message.includes('locationId:')
    );
    
    if (locationIdLog) {
      // Extract locationId from the message
      const locationIdMatch = locationIdLog.message.match(/locationId: ([^\s]+)/);
      if (locationIdMatch) {
        const locationId = locationIdMatch[1];
        errorLocationIds.add(locationId);
        errorDetails.push({
          timestamp: log.TimeUTC,
          locationId: locationId,
          requestId: requestId,
          contactId: extractContactId(logs, requestId)
        });
      }
    }
  }
});

// Helper function to extract contactId
function extractContactId(logs, requestId) {
  const contactIdLog = logs.find(l => 
    l.requestId === requestId && 
    l.message && 
    l.message.includes('contactId:')
  );
  
  if (contactIdLog) {
    const contactIdMatch = contactIdLog.message.match(/contactId: ([^\s]+)/);
    return contactIdMatch ? contactIdMatch[1] : null;
  }
  return null;
}

// Convert Set to Array and sort
const uniqueErrorLocationIds = Array.from(errorLocationIds).sort();

console.log('=== MISSING DATA ERROR ANALYSIS ===');
console.log(`Total unique location IDs with errors: ${uniqueErrorLocationIds.length}`);
console.log('\n=== UNIQUE LOCATION IDs WITH ERRORS ===');
uniqueErrorLocationIds.forEach((locationId, index) => {
  console.log(`${index + 1}. ${locationId}`);
});

console.log('\n=== DETAILED ERROR BREAKDOWN ===');
errorDetails.forEach((detail, index) => {
  console.log(`${index + 1}. Time: ${detail.timestamp}`);
  console.log(`   Location ID: ${detail.locationId}`);
  console.log(`   Contact ID: ${detail.contactId || 'N/A'}`);
  console.log(`   Request ID: ${detail.requestId}`);
  console.log('');
});

// Save results to file
const results = {
  totalUniqueErrors: uniqueErrorLocationIds.length,
  uniqueLocationIds: uniqueErrorLocationIds,
  errorDetails: errorDetails
};

fs.writeFileSync('error_locations_analysis.json', JSON.stringify(results, null, 2));
console.log('\n=== RESULTS SAVED ===');
console.log('Detailed results saved to: error_locations_analysis.json');