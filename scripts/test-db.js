// test-mongodb.js - Run this script separately to test MongoDB functionality
require('dotenv').config();
const mongoose = require('mongoose');

// Connect to MongoDB
async function testDatabase() {
  try {
    console.log(`Attempting to connect to MongoDB at: ${process.env.MONGODB_URI}`);
    
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    console.log('✅ Successfully connected to MongoDB!');
    
    // Define a simple test schema
    const TestSchema = new mongoose.Schema({
      name: String,
      created: { type: Date, default: Date.now }
    });
    
    // Create a model
    const Test = mongoose.model('Test', TestSchema);
    
    // Create and save a test document
    console.log('Creating test document...');
    const testDoc = new Test({ name: `Test-${Date.now()}` });
    await testDoc.save();
    console.log('✅ Test document saved successfully!');
    
    // Retrieve the document
    const found = await Test.findById(testDoc._id);
    console.log(`✅ Retrieved test document: ${found.name}`);
    
    // List all collections in the database
    console.log('Collections in database:');
    const collections = await mongoose.connection.db.listCollections().toArray();
    collections.forEach(coll => {
      console.log(`- ${coll.name}`);
    });
    
    // Check if User collection exists and has documents
    if (collections.some(c => c.name === 'users')) {
      const userCount = await mongoose.connection.db.collection('users').countDocuments();
      console.log(`Found ${userCount} documents in users collection`);
      
      if (userCount > 0) {
        const users = await mongoose.connection.db.collection('users').find({}).limit(1).toArray();
        console.log('Sample user data:');
        console.log(JSON.stringify(users[0], null, 2));
      }
    }
    
    // Disconnect
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    
  } catch (error) {
    console.error('❌ MongoDB test error:', error.message);
    if (error.name === 'MongoServerSelectionError') {
      console.log('This usually indicates connection issues like wrong credentials, IP restrictions, or network problems.');
    }
  }
}

// Run the test
testDatabase();