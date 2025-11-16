// server.js

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb'); 
const bcrypt = require('bcrypt');
const firebase = require('firebase/app'); 

// 🎯 SECURE IMPORT: Imports the initialized Admin SDK using environment variables
const admin = require('./firebaseAdmin'); 

// ✅ UPDATED IMPORT: Uses the new Firebase-based verification function
const { sendFirebaseVerificationEmail, sendApplicationStatusEmail } = require('./emailService'); 

// --- 1. CORE EXPRESS INITIALIZATION ---
const app = express();
// Use environment variable for PORT in production
const PORT = process.env.PORT || 3000; 
// --- END CORE SETUP ---

// --- 2. CONFIGURATION / MIDDLEWARE ---
// Use dynamic CORS setup to allow access from various origins during development/deployment
const allowedOrigins = [
    'http://localhost:3000', // Default Express port
    'http://localhost:5500', // Default Live Server port
    'http://localhost:8080', // Common development port
    process.env.FRONTEND_URL // Use environment variable for the deployed frontend URL
];

// 🔄 UPDATED CORS CONFIGURATION
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || origin.endsWith('.onrender.com')) {
            return callback(null, true);
        }
        // NOTE: We're allowing any origin ending in '.onrender.com' for flexibility.
        callback(new Error('Not allowed by CORS'));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
}));

app.use(express.json()); 

// Serve static files from the 'public' folder
app.use(express.static('public'));

// 🎯 MONGO DB CONFIG (Using Environment Variable is HIGHLY Recommended for URI)
// NOTE: For Render, you should set a MONGO_URI environment variable.
const uri = process.env.MONGO_URI || "mongodb+srv://ar09_db_userunandn:k6tBypac5gDjylF0@loaiskoportalemailverif.6awvwxe.mongodb.net/?appName=LOAISKOPORTALEmailVerification"; 
const DB_NAME = "scholarship_db"; 
const STUDENTS_COLLECTION = "students"; 
const APPLICATIONS_COLLECTION = "applications"; 

const saltRounds = 10;
const client = new MongoClient(uri);
let studentsCollection; 
let applicationsCollection; 


// 🔑 FIREBASE CLIENT CONFIGURATION (PUBLIC & SAFE TO EXPOSE)
// These should be configured as environment variables in your Render service.
const FIREBASE_CLIENT_CONFIG = {
    apiKey: process.env.FIREBASE_PUBLIC_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET, 
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID 
};


// --- 5. FIREBASE ADMIN INITIALIZATION ---
// The initialization logic has been moved entirely to ./firebaseAdmin.js
// The imported 'admin' object above is already initialized.


// --- 6. FIREBASE/FIRESTORE SYNC UTILITY (Remains the same) ---
/**
 * Utility function to sync a verified user to Firebase Auth and Firestore 'students' collection.
 */
async function syncUserToFirebase(user) {
    const { studentNo, email, firstName, middleInitial, lastName, role, course, yearLevel } = user;
    let firebaseUid = studentNo; 
    
    // 1. Sync to Firebase Authentication
    try {
        await admin.auth().getUser(studentNo);
        
        await admin.auth().updateUser(studentNo, {
            email: email,
            emailVerified: true,
            displayName: `${firstName} ${lastName}`,
        });
        console.log(`🔄 Updated existing Firebase Auth user: ${studentNo}`);

    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            try {
                const newUser = await admin.auth().createUser({
                    uid: studentNo, 
                    email: email,
                    emailVerified: true,
                    displayName: `${firstName} ${lastName}`,
                });
                firebaseUid = newUser.uid;
                console.log(`✅ Created new Firebase Auth user: ${newUser.uid}`);
            } catch (createError) {
                if (createError.code === 'auth/email-already-exists') {
                    console.error(`❌ CRITICAL CONFLICT: Email ${email} is linked to a different Firebase UID. Cannot proceed with studentNo: ${studentNo}. User must be manually merged or deleted.`);
                    throw new Error("Email is already in use by another Firebase account. Contact support for account reset.");
                } else {
                    console.error("❌ Firebase Auth Sync Failed on create:", createError);
                    throw new Error(`Firebase Auth synchronization failed: ${createError.message}`); 
                }
            }
        } else {
            console.error("❌ Firebase Auth Sync Failed on get/update:", error);
            throw new Error(`Firebase Auth synchronization failed: ${error.message}`); 
        }
    }
    
    // 2. Sync data to Firestore 'students' collection
    try {
        const firestoreDb = admin.firestore();
        const studentProfileRef = firestoreDb.collection('students').doc(firebaseUid); 
        
        await studentProfileRef.set({
            firebaseUid: firebaseUid, 
            studentNo: studentNo, 
            firstName,
            middleInitial,
            lastName,
            email, 
            course,
            yearLevel,
            role,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }); 
        
        console.log(`✅ Synced student profile to Firestore 'students' collection for UID ${firebaseUid}.`);

    } catch (firestoreError) {
        console.error("❌ Firestore Profile Sync Failed:", firestoreError);
        throw new Error(`Firestore profile synchronization failed: ${firestoreError.message}`); 
    }

    return firebaseUid; 
}
// -------------------------------------------------------------------------------------


// --- 8. MIDDLEWARE DEFINITIONS ---

// Middleware to check if the database connection is ready
const checkDbConnection = (req, res, next) => {
    if (!studentsCollection || !applicationsCollection) { 
        console.error("❌ Database collection is not ready. Server may still be connecting.");
        return res.status(503).json({ success: false, message: "Server initializing or database unavailable. Please try again in a moment." });
    }
    next();
};

// Apply DB connection check to all API routes
app.use('/api', checkDbConnection);


// 🛡️ ADMIN MIDDLEWARE (PLACEHOLDER - SHOULD VERIFY FIREBASE ID TOKEN ROLE) 🛡️
const verifyAdmin = async (req, res, next) => {
    // ⚠️ TODO: Implement real token verification and role check here using Firebase Admin SDK:
    // const idToken = req.headers.authorization.split('Bearer ')[1];
    // const decodedToken = await admin.auth().verifyIdToken(idToken);
    // if (decodedToken.role !== 'admin') { return res.status(403).json(...) }
    
    console.log("[Middleware Placeholder] Admin authentication assumed successful.");
    return next();
};


// --- 9. API ENDPOINTS (Routes) ---

/**
 * 🔑 NEW SECURE ROUTE: GET /api/firebase-config
 * Serves the public client Firebase configuration to the frontend dynamically.
 */
app.get('/api/firebase-config', (req, res) => {
    if (!FIREBASE_CLIENT_CONFIG.apiKey) {
        console.error("❌ Firebase client config is missing API key. Check environment variables.");
        return res.status(500).json({ success: false, message: "Configuration error." });
    }
    res.json(FIREBASE_CLIENT_CONFIG);
});


/**
 * POST /api/register (Updated for Firebase Auth)
 */
app.post('/api/register', async (req, res) => {
    const { firstName, middleInitial, lastName, studentNo, course, yearLevel, email, password } = req.body;

    if (!email || !password || !studentNo) {
        return res.status(400).json({ success: false, message: "Email, password, and Student Number are required." });
        }

    try {
        // Check if studentNo is already registered
        const existingStudent = await studentsCollection.findOne({ studentNo });
        if (existingStudent) {
            console.warn(`⚠️ Blocked registration attempt: Student No ${studentNo} already registered.`);
            return res.status(409).json({ success: false, message: '**Student Number already registered**. Please check your Student Number or log in.' });
        }

        // Check if email is already registered
        const existingUser = await studentsCollection.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'This email is already registered. Please log in.' });
        }
        
        // --- 1. Create User in Firebase Auth First (Best Practice) ---
        const firebaseUser = await admin.auth().createUser({
            uid: studentNo, // Enforce studentNo as the UID
            email: email,
            password: password, // Temp password for Auth, will be checked against Hashed password in Mongo on login
            displayName: `${firstName} ${lastName}`,
            emailVerified: false, 
        });
        
        // --- 2. Save Hashed Password and User Details to MongoDB ---
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        
        const newUserDocument = {
            firstName, middleInitial, lastName, studentNo, course, yearLevel, email,
            password: hashedPassword,
            role: "student",
            isVerified: false, // Remains false until the link is clicked
            createdAt: new Date(),
        };

        await studentsCollection.insertOne(newUserDocument);
        
        // --- 3. Send verification email via Firebase Service ---
        const frontendRedirectUrl = process.env.FRONTEND_VERIFICATION_URL; 
        
        if (!frontendRedirectUrl) {
             // Rollback: Delete user from Firebase Auth and Mongo
             await admin.auth().deleteUser(firebaseUser.uid); 
             await studentsCollection.deleteOne({ email }); 
             return res.status(500).json({ success: false, message: "Server configuration error: FRONTEND_VERIFICATION_URL is missing. Registration failed." });
        }

        const emailSent = await sendFirebaseVerificationEmail(email, frontendRedirectUrl); 
        
        if (!emailSent) {
            console.error(`❌ FAILED to send verification email for ${email}. Deleting user.`);
            // Rollback: Delete user from Firebase Auth and Mongo
            await admin.auth().deleteUser(firebaseUser.uid); 
            await studentsCollection.deleteOne({ email }); 
            return res.status(500).json({ success: false, message: "Registration failed: Could not send verification email. Please try again later." });
        }
        
        console.log(`✅ User registered (pending verification): ${email}`);
        
        res.json({ 
            success: true, 
            message: `Registration successful. A verification link has been sent to your email (${email}). Please check your inbox to verify your account and log in.` 
        });

    } catch (error) {
        console.error("❌ Registration Failed:", error);
        
        // Handle MongoDB duplicate key error 
        if (error.code === 11000) {
            let detail = 'A user with this email or student number already exists.';
            if (error.message.includes('studentNo')) {
                 detail = 'The **Student Number** is already registered.';
            } else if (error.message.includes('email')) {
                 detail = 'The Email is already registered.';
            }
            return res.status(409).json({ success: false, message: detail });
        }

        // Handle Firebase Auth errors (e.g., email-already-in-use)
        if (error.code && error.code.startsWith('auth/')) {
            return res.status(409).json({ success: false, message: `Registration failed (Auth): ${error.message}` });
        }
        
        res.status(500).json({ success: false, message: "Server error during registration" });
    }
});


/**
 * POST /api/login-and-sync (Remains functional for MongoDB login check)
 */
app.post('/api/login-and-sync', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    try {
        const user = await studentsCollection.findOne({ email });
        
        if (!user) { 
            return res.status(401).json({ success: false, message: "Invalid email or password." }); 
        }
        
        // Verification check (Still relies on MongoDB's isVerified flag)
        if (!user.isVerified) {
            console.warn(`⚠️ Blocked login: User ${email} is not verified.`);
            return res.status(403).json({ 
                success: false, 
                message: "Account is not verified. Redirecting to verification page.",
                needsVerification: true 
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) { 
            return res.status(401).json({ success: false, message: "Invalid email or password." }); 
        }

        // 1. Sync user data and get the final Firebase UID used
        let firebaseUid;

        try {
            firebaseUid = await syncUserToFirebase(user); 
            
            // 2. Generate custom token using the determined UID
            const customToken = await admin.auth().createCustomToken(firebaseUid);


            // 3. Final successful response
            const profileData = {
                studentNo: user.studentNo,
                firebaseUid: firebaseUid, 
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
            };

            res.json({ 
                success: true, 
                message: "Login successful.", 
                user: profileData,
                token: customToken // 🔑 CRITICAL: This sends the token to the client.
            });


        } catch (error) {
            console.error("❌ Firebase Sync/Token Failed during login:", error.message);
            return res.status(500).json({
                success: false, 
                message: `Login failed due to Firebase synchronization issue: ${error.message}`
            });
        }

    } catch (error) {
        console.error("❌ Login Failed (Database):", error);
        res.status(500).json({ success: false, message: "Server error during login" });
    }
});


/**
 * POST /api/resend-verification (Updated for Firebase Auth link generation)
 */
app.post('/api/resend-verification', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: "Email is required." });
    }

    try {
        const user = await studentsCollection.findOne({ email });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (user.isVerified) {
            return res.json({ success: true, message: "Account is already verified. Please log in." });
        }
        
        const frontendRedirectUrl = process.env.FRONTEND_VERIFICATION_URL; 
        if (!frontendRedirectUrl) {
            return res.status(500).json({ success: false, message: "Server configuration error: FRONTEND_VERIFICATION_URL is missing." });
        }

        // Use the Firebase service to send a new verification link
        const emailSent = await sendFirebaseVerificationEmail(email, frontendRedirectUrl);

        if (!emailSent) {
            return res.status(500).json({ success: false, message: "Failed to send new verification email. Check server logs." });
        }

        console.log(`✉️ Resent Firebase verification link to ${email}`);
        res.json({ success: true, message: `A new verification link has been sent to ${email}.` });

    } catch (error) {
        console.error("❌ Resend Link Failed:", error);
        res.status(500).json({ success: false, message: "Server error during resend verification operation." });
    }
});


/**
 * POST /api/send-status-email (Remains functional for status updates)
 */
app.post('/api/send-status-email', verifyAdmin, async (req, res) => {
    const { docId, status, email, name, scholarshipType } = req.body; 

    if (!status || !email || !name || !scholarshipType) {
        return res.status(400).json({ 
            success: false, 
            message: "Missing required fields: status, email, name, and scholarshipType are needed to send confirmation." 
        });
    }

    try {
        const emailSent = await sendApplicationStatusEmail(email, name, scholarshipType, status);

        if (!emailSent) {
            console.error(`❌ FAILED to send ${status} email to ${email}.`);
            return res.status(500).json({ success: false, message: `Failed to send confirmation email for status ${status}.` });
        }

        console.log(`✅ Status confirmation email sent for Application ${docId} (Status: ${status}) to ${email}.`);
        res.json({ 
            success: true, 
            message: `Confirmation email for status ${status} successfully sent to ${email}.` 
        });

    } catch (error) {
        console.error("❌ Failed to process status email request:", error);
        res.status(500).json({ success: false, message: "Internal server error while attempting to send email." });
    }
});


/**
 * DELETE /api/admin/delete-student (Remains the same)
 */
app.delete('/api/admin/delete-student', verifyAdmin, async (req, res) => {
    const { studentNo, email } = req.body;

    if (!studentNo || !email) {
        return res.status(400).json({ success: false, message: "Student Number (UID) and email are required for deletion." });
    }
    
    let mongoDeleted = false;
    let authDeleted = false;

    try {
        const mongoResult = await studentsCollection.deleteOne({ email });
        mongoDeleted = mongoResult.deletedCount > 0;
        
        if (mongoDeleted) {
            console.log(`🗑️ Successfully deleted student from MongoDB: ${email}`);
        } else {
            console.warn(`⚠️ MongoDB warning: User with email ${email} not found.`);
        }

        try {
            await admin.auth().deleteUser(studentNo); 
            authDeleted = true;
            console.log(`🔥 Successfully deleted user from Firebase Auth (UID: ${studentNo})`);
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                console.warn(`⚠️ Firebase Auth warning: User with UID ${studentNo} not found in Auth. Proceeding...`);
            } else {
                throw error;
            }
        }

        try {
            const firestoreDb = admin.firestore();
            await firestoreDb.collection('students').doc(studentNo).delete(); 
            await firestoreDb.collection('student_profiles').doc(studentNo).delete(); 
            console.log(`🗑️ Successfully deleted student documents from Firestore.`);
        } catch (error) {
            console.warn(`⚠️ Firestore warning: Could not delete student documents for ${studentNo}.`, error.message);
        }
        
        if (!mongoDeleted && !authDeleted) {
            return res.status(404).json({ success: false, message: "No record found in MongoDB or Firebase Auth to delete." });
        }

        res.json({ 
            success: true, 
            message: "Student successfully deleted from MongoDB, Firebase Auth, and Firestore.",
            mongoDeleted: mongoDeleted,
            authDeleted: authDeleted
        });

    } catch (error) {
        console.error("❌ Admin Deletion Failed:", error);
        res.status(500).json({ success: false, message: `Server error during deletion: ${error.message}` });
    }
});


// --- 10. INITIALIZATION ---

let serverInitialized = false; 

/**
 * Connects to the database and starts the Express server.
 */
async function initializeServer() {
    if (serverInitialized) {
        return; 
    }
    serverInitialized = true;

    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db(DB_NAME);
        studentsCollection = db.collection(STUDENTS_COLLECTION);
        applicationsCollection = db.collection(APPLICATIONS_COLLECTION); 
        
        console.log("✅ MongoDB successfully connected and collections ready.");

        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("❌ Fatal Error: Failed to connect to MongoDB or start server.", error);
        process.exit(1); 
    }

    process.on('SIGINT', async () => {
        console.log('\n🛑 Server shutting down. Closing MongoDB connection...');
        await client.close();
        console.log('✅ MongoDB connection closed.');
        process.exit(0);
    });
}

// Start the initialization process (ONLY ONE CALL IS REQUIRED)
initializeServer();