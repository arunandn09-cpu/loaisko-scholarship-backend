// server.js

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb'); 
const bcrypt = require('bcrypt');
const firebase = require('firebase/app'); 

// 🎯 SECURE IMPORT: Imports the initialized Admin SDK using environment variables
const admin = require('./firebaseAdmin'); 

// ✅ UPDATED IMPORT: Uses the MailerSend-powered verification function
const { sendFirebaseVerificationEmail, sendApplicationStatusEmail } = require('./emailService'); 

// --- 1. CORE EXPRESS INITIALIZATION ---
const app = express();
// Use environment variable for PORT in production
const PORT = process.env.PORT || 3000; 
// --- END CORE SETUP ---

// --- 2. CONFIGURATION / MIDDLEWARE ---

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


// --- 5. FIREBASE ADMIN INITIALIZATION (Handled in firebaseAdmin.js) ---


// --- 6. FIREBASE/FIRESTORE SYNC UTILITY (Remains the same - only syncs a verified user) ---
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
                    uid: studentNo, // Enforce studentNo as the UID
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


// --- 8. MIDDLEWARE DEFINITIONS (Remains the same) ---

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

// 🚀 CRITICAL CORS FIX START (Remains the same) 🚀
/**
 * 🔑 MANUAL CORS HANDLER: OPTIONS /api/firebase-config
 */
app.options('/api/firebase-config', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://loaiskoportal.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); 
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.sendStatus(200); 
});

/**
 * 🔑 NEW SECURE ROUTE: GET /api/firebase-config
 */
app.get('/api/firebase-config', (req, res) => {
    // ⬇️ CRITICAL FIX: Manually set CORS headers for the GET request ⬇️
    res.setHeader('Access-Control-Allow-Origin', 'https://loaiskoportal.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (!FIREBASE_CLIENT_CONFIG.apiKey) {
        console.error("❌ Firebase client config is missing API key. Check environment variables.");
        return res.status(500).json({ success: false, message: "Configuration error." });
    }
    res.json(FIREBASE_CLIENT_CONFIG);
});
// 🚀 CRITICAL CORS FIX END 🚀


// 🆕 NEW VERIFICATION ENDPOINT
/**
 * POST /api/verify-email
 * Handles the action code sent by the frontend after the user clicks the email link.
 */
app.post('/api/verify-email', async (req, res) => {
    // The frontend sends the action code (oobCode) received from the Firebase verification link.
    const { oobCode } = req.body; 

    if (!oobCode) {
        return res.status(400).json({ success: false, message: "Missing action code." });
    }

    let emailToVerify;

    try {
        // 1. Check the action code to get the email (Uses Firebase Admin)
        const result = await admin.auth().checkActionCode(oobCode);
        emailToVerify = result.data.email;
        
        // 2. Apply the action code to mark the user as verified in Firebase Auth
        await admin.auth().applyActionCode(oobCode);

        // 3. Update the user's status in MongoDB
        const updateResult = await studentsCollection.findOneAndUpdate(
            { email: emailToVerify },
            { 
                $set: { isVerified: true, verifiedAt: new Date() },
            },
            { returnDocument: 'after' } // Return the updated document
        );
        
        const user = updateResult.value;

        if (!user) {
            console.error(`❌ Verification success in Firebase, but MongoDB user not found: ${emailToVerify}`);
            return res.status(404).json({ success: false, message: "User not found in database after verification." });
        }
        
        console.log(`✅ Account verified and MongoDB updated for: ${emailToVerify}`);

        res.json({ 
            success: true, 
            message: "Email successfully verified. You can now log in.",
            userEmail: emailToVerify 
        });

    } catch (error) {
        console.error("❌ Email Verification Failed:", error.message);
        
        // Handle Firebase action code errors
        if (error.code === 'auth/invalid-action-code') {
            return res.status(400).json({ success: false, message: "The verification link is invalid or has expired." });
        }
        
        res.status(500).json({ success: false, message: `Server error during verification: ${error.message}` });
    }
});


/**
 * POST /api/register 
 * 🚨 MODIFIED: Removed frontendRedirectUrl from email service call.
 */
app.post('/api/register', async (req, res) => {
    const { firstName, middleInitial, lastName, studentNo, course, yearLevel, email, password } = req.body;

    if (!email || !password || !studentNo) {
        return res.status(400).json({ success: false, message: "Email, password, and Student Number are required." });
        }

    try {
        // Check for existing users (MongoDB logic remains the same)
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
        // This check is no longer strictly necessary, but good for environment setup validation
        const frontendRedirectUrl = process.env.FRONTEND_URL; 
        
        if (!frontendRedirectUrl) {
             // Rollback: Delete user from Firebase Auth and Mongo
             await admin.auth().deleteUser(firebaseUser.uid); 
             await studentsCollection.deleteOne({ email }); 
             return res.status(500).json({ success: false, message: "Server configuration error: FRONTEND_URL is missing. Registration failed." });
        }

        // 🚨 CRITICAL CHANGE: Removed `frontendRedirectUrl` parameter
        const emailSent = await sendFirebaseVerificationEmail(email); 
        
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
        
        // Error handling remains the same
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
 * POST /api/login-and-sync (Remains the same)
 */
app.post('/api/login-and-sync', async (req, res) => {
// ... (Logic remains the same)
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
 * POST /api/resend-verification 
 * 🚨 MODIFIED: Removed frontendRedirectUrl from email service call.
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
        
        // Environment variable check remains for safety
        const frontendRedirectUrl = process.env.FRONTEND_URL; 
        if (!frontendRedirectUrl) {
            return res.status(500).json({ success: false, message: "Server configuration error: FRONTEND_URL is missing." });
        }

        // 🚨 CRITICAL CHANGE: Removed `frontendRedirectUrl` parameter
        const emailSent = await sendFirebaseVerificationEmail(email);

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
// ... (Logic remains the same)
    const { docId, status, email, name, scholarshipType } = req.body; 

    if (!status || !email || !name || !scholarshipType) {
        return res.status(400).json({ 
            success: false, 
            message: "Missing required fields: status, email, name, and scholarshipType are needed to send confirmation." 
        });
    }

    try {
        // Function signature remains the same as status emails don't use Firebase links
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
// ... (Logic remains the same)
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


// --- 10. INITIALIZATION (Remains the same) ---

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