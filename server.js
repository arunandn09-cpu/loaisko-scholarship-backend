const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb'); 
const bcrypt = require('bcrypt');
const firebase = require('firebase/app'); 

// 🎯 SECURE IMPORT: Imports the initialized Admin SDK using environment variables
const admin = require('./firebaseAdmin'); 

// ✅ UPDATED IMPORT: Uses the Resend-compatible functions from emailService.js
const { 
    generateVerificationCode, 
    sendCustomVerificationCodeEmail, 
    sendApplicationStatusEmail 
} = require('./emailService'); 

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
const uri = process.env.MONGO_URI; 
const DB_NAME = "scholarship_db"; 
const STUDENTS_COLLECTION = "students"; 
const APPLICATIONS_COLLECTION = "applications"; 

const saltRounds = 10;
const client = new MongoClient(uri);
let studentsCollection; 
let applicationsCollection; 


// 🔑 FIREBASE CLIENT CONFIGURATION (PUBLIC & SAFE TO EXPOSE)
const FIREBASE_CLIENT_CONFIG = {
    apiKey: process.env.FIREBASE_API_KEY,      
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET, 
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID 
};

// --- Helper Function: syncUserToFirebase (Unchanged, remains critical for data integrity) ---
async function syncUserToFirebase(user) {
    const { studentNo, email, firstName, middleInitial, lastName, role, course, yearLevel } = user;
    let firebaseUid = studentNo; 
    
    // 1. Sync to Firebase Authentication
    try {
        await admin.auth().getUser(studentNo);
        
        const isVerified = user.isVerified || false; 

        await admin.auth().updateUser(studentNo, {
            email: email,
            emailVerified: isVerified, 
            displayName: `${firstName} ${lastName}`,
        });
        console.log(`🔄 Updated existing Firebase Auth user: ${studentNo} (Verified: ${isVerified})`);

    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            try {
                // If user doesn't exist, create them
                const newUser = await admin.auth().createUser({
                    uid: studentNo, // Enforce studentNo as the UID
                    email: email,
                    emailVerified: false, 
                    displayName: `${firstName} ${lastName}`,
                });
                firebaseUid = newUser.uid;
                console.log(`✅ Created new Firebase Auth user: ${newUser.uid}`);
            } catch (createError) {
                if (createError.code === 'auth/email-already-exists') {
                    console.error(`❌ CRITICAL CONFLICT: Email ${email} is linked to a different Firebase UID. User must be manually merged or deleted.`);
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
            // If the user is verified, update the Firestore timestamp.
            verifiedAt: user.isVerified ? admin.firestore.FieldValue.serverTimestamp() : null,
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
        if (!process.env.MONGO_URI) {
            return res.status(500).json({ success: false, message: "Server is misconfigured (MONGO_URI missing)." });
        }
        return res.status(503).json({ success: false, message: "Server initializing or database unavailable. Please try again in a moment." });
    }
    next();
};

// Apply DB connection check to all API routes
app.use('/api', checkDbConnection);


// 🛡️ ADMIN MIDDLEWARE (PLACEHOLDER - SHOULD VERIFY FIREBASE ID TOKEN ROLE) 🛡️
const verifyAdmin = async (req, res, next) => {
    // ⚠️ TODO: Implement real token verification and role check here using Firebase Admin SDK
    console.log("[Middleware Placeholder] Admin authentication assumed successful.");
    return next();
};


// --- 9. API ENDPOINTS (Routes) ---

// 🚀 CORS and Firebase Config Route (Updated for clarity) 🚀

const FRONTEND_ORIGIN = 'https://loaiskoportal.web.app'; 

app.use(cors({ 
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true 
}));

/**
 * 🔑 NEW SECURE ROUTE: GET /api/firebase-config
 */
app.get('/api/firebase-config', (req, res) => {
    
    if (!FIREBASE_CLIENT_CONFIG.apiKey) {
        console.error("❌ Firebase client config is missing API key. Check environment variables.");
        return res.status(500).json({ success: false, message: "Configuration error: Missing public API key." });
    }
    res.json(FIREBASE_CLIENT_CONFIG);
});
// 🚀 CRITICAL CORS FIX END 🚀


// 🆕 NEW VERIFICATION ENDPOINT: POST /api/submit-code
app.post('/api/submit-code', async (req, res) => {
    const { email, code } = req.body; 

    if (!email || !code) {
        return res.status(400).json({ success: false, message: "Email and verification code are required." });
    }

    try {
        const user = await studentsCollection.findOne({ email });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (user.isVerified) {
            return res.json({ success: true, message: "Account is already verified. Please log in." });
        }

        // 1. Check if the provided code matches and is not expired
        const now = new Date();
        if (user.verificationCode !== code) {
            return res.status(400).json({ success: false, message: "Invalid verification code." });
        }
        if (user.codeExpiresAt && user.codeExpiresAt < now) {
            // We can optionally delete the expired code fields here
            await studentsCollection.updateOne({ email }, { $unset: { verificationCode: "", codeExpiresAt: "" } });
            return res.status(400).json({ success: false, message: "Verification code has expired. Please request a new one." });
        }
        
        // 2. Mark as verified in MongoDB and clear code fields
        const updateResult = await studentsCollection.findOneAndUpdate(
            { email: email },
            { 
                $set: { isVerified: true, verifiedAt: new Date() },
                $unset: { verificationCode: "", codeExpiresAt: "" } 
            },
            { returnDocument: 'after' } 
        );
        
        // 3. Update Firebase Auth to reflect verified status
        try {
            await admin.auth().updateUser(user.studentNo, { emailVerified: true });
            console.log(`✅ Firebase Auth user ${user.studentNo} marked as verified.`);
        } catch (authUpdateError) {
            console.error("❌ Firebase Auth update failed during code verification:", authUpdateError);
            // Non-critical failure: log it, but verification continues as MongoDB is primary source
        }

        console.log(`✅ Account verified (Code-based) and MongoDB/Firebase updated for: ${email}`);

        res.json({ 
            success: true, 
            message: "Email successfully verified. You can now log in.",
            userEmail: email 
        });

    } catch (error) {
        console.error("❌ Code Verification Failed:", error.message);
        res.status(500).json({ success: false, message: `Server error during verification: ${error.message}` });
    }
});


/**
 * POST /api/register (FIXED: Does not delete user if email fails)
 */
app.post('/api/register', async (req, res) => {
    const { firstName, middleInitial, lastName, studentNo, course, yearLevel, email, password } = req.body;

    if (!email || !password || !studentNo) {
        return res.status(400).json({ success: false, message: "Email, password, and Student Number are required." });
    }

    try {
        const existingStudent = await studentsCollection.findOne({ studentNo });
        if (existingStudent) {
            console.warn(`⚠️ Blocked registration attempt: Student No ${studentNo} already registered.`);
            return res.status(409).json({ success: false, message: '**Student Number already registered**. Please check your Student Number or log in.' });
        }

        const existingUser = await studentsCollection.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'This email is already registered. Please log in.' });
        }
        
        // --- NEW CODE GENERATION & STORAGE ---
        const verificationCode = generateVerificationCode(); 
        // Code expires in 15 minutes (900,000 milliseconds)
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000); 
        // --- END NEW CODE ---
        
        // 1. Create user in Firebase Auth
        const firebaseUser = await admin.auth().createUser({
            uid: studentNo, 
            email: email,
            password: password, 
            displayName: `${firstName} ${lastName}`,
            emailVerified: false, 
        });
        
        // 2. Hash password and save user in MongoDB
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        
        const newUserDocument = {
            firstName, middleInitial, lastName, studentNo, course, yearLevel, email,
            password: hashedPassword,
            role: "student",
            isVerified: false, 
            verificationCode: verificationCode, 
            codeExpiresAt: codeExpiresAt,      
            createdAt: new Date(),
        };

        await studentsCollection.insertOne(newUserDocument);
        
        // 3. Send the custom code email using the Resend implementation
        const emailSent = await sendCustomVerificationCodeEmail(email, verificationCode); 
        
        if (!emailSent) {
            // ⭐ FIX APPLIED: DO NOT DELETE THE USER ACCOUNT
            console.warn(`⚠️ User created but FAILED to send verification email to ${email}. Account will remain pending verification.`);
            
            // Return success (200) to the client, but include a warning message.
            // This ensures the client redirects to verify.html, where they can click "Resend Code".
            return res.json({ 
                success: true, 
                message: `Registration successful. NOTE: Verification code email failed to send, please click "Resend Code" on the next screen.` 
            });
        }
        
        // --- Success Path ---
        console.log(`✅ User registered (pending verification) and code sent: ${email}`);
        
        res.json({ 
            success: true, 
            message: `Registration successful. A verification code has been sent to your email (${email}). Please enter the code to verify your account and log in.` 
        });

    } catch (error) {
        console.error("❌ Registration Failed:", error);
        
        // Handle database/auth conflicts (e.g., studentNo or email duplicate, Firebase user exists)
        if (error.code === 11000) {
            let detail = 'A user with this email or student number already exists.';
            if (error.message.includes('studentNo')) {
                detail = 'The **Student Number** is already registered.';
            } else if (error.message.includes('email')) {
                detail = 'The Email is already registered.';
            }
            return res.status(409).json({ success: false, message: detail });
        }

        if (error.code && error.code.startsWith('auth/')) {
            // Note: If Firebase creation succeeded but MongoDB failed, the user will exist in Firebase.
            // If the Firebase error is about email-already-exists, the frontend handles the 409 status.
            return res.status(409).json({ success: false, message: `Registration failed (Auth): ${error.message}` });
        }
        
        res.status(500).json({ success: false, message: "Server error during registration" });
    }
});


/**
 * POST /api/login-and-sync (Logic unchanged)
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
        
        if (!user.isVerified) {
            console.warn(`⚠️ Blocked login: User ${email} is not verified.`);
            return res.status(403).json({ 
                success: false, 
                message: "Account is not verified. Please enter the verification code sent to your email.",
                needsVerification: true,
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) { 
            return res.status(401).json({ success: false, message: "Invalid email or password." }); 
        }

        let firebaseUid;

        try {
            // This sync call now correctly updates Firebase Auth's emailVerified status based on MongoDB.
            firebaseUid = await syncUserToFirebase(user); 
            
            const customToken = await admin.auth().createCustomToken(firebaseUid);

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
                token: customToken 
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
 * POST /api/resend-verification (Uses sendCustomVerificationCodeEmail)
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
        
        // 1. Generate new code and update MongoDB
        const newCode = generateVerificationCode();
        const newExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
        
        await studentsCollection.updateOne(
            { email },
            { $set: { verificationCode: newCode, codeExpiresAt: newExpiresAt } }
        );

        // 2. Send the new custom code using the Resend implementation
        const emailSent = await sendCustomVerificationCodeEmail(email, newCode);

        if (!emailSent) {
            return res.status(500).json({ success: false, message: "Failed to send new verification code. Check server logs." });
        }

        console.log(`✉️ Resent custom verification code to ${email}`);
        res.json({ success: true, message: `A new verification code has been sent to ${email}.` });

    } catch (error) {
        console.error("❌ Resend Code Failed:", error);
        res.status(500).json({ success: false, message: "Server error during resend verification operation." });
    }
});


/**
 * POST /api/send-status-email (Uses sendApplicationStatusEmail)
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
        // Uses the updated Resend-compatible function
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
 * DELETE /api/admin/delete-student (Logic unchanged)
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


// --- 10. INITIALIZATION (Modified to check for MONGO_URI) ---

let serverInitialized = false; 

/**
 * Connects to the database and starts the Express server.
 */
async function initializeServer() {
    if (serverInitialized) {
        return; 
    }
    serverInitialized = true;

    if (!uri) {
        console.error("❌ Fatal Error: MONGO_URI is not set in environment variables. Cannot connect to database.");
        process.exit(1);
    }

    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db(DB_NAME);
        studentsCollection = db.collection(STUDENTS_COLLECTION);
        applicationsCollection = db.collection(APPLICATIONS_COLLECTION); 
        
        // Ensure unique indexes exist for critical fields
        await studentsCollection.createIndex({ studentNo: 1 }, { unique: true });
        await studentsCollection.createIndex({ email: 1 }, { unique: true });
        
        console.log("✅ MongoDB successfully connected, collections ready, and indexes applied.");

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