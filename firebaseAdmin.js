// firebaseAdmin.js

const admin = require('firebase-admin');

// --- 1. Load Secure Credentials from Environment ---
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
// NOTE: FIREBASE_DATABASE_URL is optional, needed only if you use the Realtime Database
const databaseURL = process.env.FIREBASE_DATABASE_URL; 

if (!serviceAccountJson) {
  throw new Error("CRITICAL: FIREBASE_SERVICE_ACCOUNT environment variable is not set. Cannot initialize Admin SDK.");
}

// --- 2. Initialize the Firebase Admin SDK ---
try {
  const serviceAccount = JSON.parse(serviceAccountJson);
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: databaseURL 
    });
    console.log("🔥 Firebase Admin SDK initialized successfully.");
  }

} catch (error) {
  console.error("❌ ERROR: Failed to parse FIREBASE_SERVICE_ACCOUNT JSON. Check your Render environment variable formatting.", error.message);
  throw error;
}

module.exports = admin;