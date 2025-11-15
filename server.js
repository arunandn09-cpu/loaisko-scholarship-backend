const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb'); 
const bcrypt = require('bcrypt');
const admin = require('firebase-admin'); 
const firebase = require('firebase/app'); 
const crypto = require('crypto');

// --- 1. CORE EXPRESS INITIALIZATION ---
const app = express();
const PORT = process.env.PORT || 10000; // Updated Port to 10000 for consistency with logs
const BASE_URL = process.env.PUBLIC_URL || 'https://loaiskoportal.web.app'; 
// --- END CORE SETUP ---

// --- 2. CONFIGURATION / MIDDLEWARE ---
app.use(cors({
    origin: [
        'https://loaiskoportal.web.app', // Your deployed frontend
        `http://localhost:3000`,      // Common local development port
        'http://127.0.0.1:3000'          // Common local address
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
})); 
app.use(express.json()); 

// 🎯 MONGO DB CONFIG
const uri = process.env.MONGO_URI || "mongodb+srv://ar09_db_userunandn:k6tBypac5gDjylF0@loaiskoportalemailverif.6awvwxe.mongodb.net/?appName=LOAISKOPORTALEmailVerification"; 
const DB_NAME = "scholarship_db"; 
const STUDENTS_COLLECTION = "students"; 
const APPLICATIONS_COLLECTION = "applications"; 

const saltRounds = 10;
const client = new MongoClient(uri);
let studentsCollection; 
let applicationsCollection; 


// --- 3. FIREBASE ADMIN INITIALIZATION (SECURE KEY LOADING) ---
// This uses the FIREBASE_SERVICE_ACCOUNT environment variable set in Render.
try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    let serviceAccount;

    if (serviceAccountJson) {
        // Parse the JSON string from the environment variable (for Render deployment)
        serviceAccount = JSON.parse(serviceAccountJson);
    } else {
        // Fallback for local development (requires local file)
        serviceAccount = require('./firebase-adminsdk.json');
    }
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK initialized.");
    }
} catch (error) {
    // This catches the 'invalid_grant' error from the old key!
    console.error("❌ Firebase Admin Initialization Failed. Ensure 'FIREBASE_SERVICE_ACCOUNT' environment variable is set and the key is valid.", error.message);
}


// --- 4. FIREBASE/FIRESTORE SYNC UTILITY (No Change) ---
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
                    uid: studentNo, // Use studentNo as the UID for linking!
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
            firstName, middleInitial, lastName, email, course, yearLevel, role,
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


// 🔑 RE-INCORPORATED: Verification code generation function
function generateVerificationCode() {
    // Generate a 6-digit code for users to manually enter
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Generate a secure, unique token for email link verification
    const token = crypto.randomBytes(32).toString('hex');
    return { code, token };
}


// --- 5. MIDDLEWARE DEFINITIONS (No Change) ---
const checkDbConnection = (req, res, next) => {
    if (!studentsCollection || !applicationsCollection) { 
        console.error("❌ Database collection is not ready. Server may still be connecting.");
        return res.status(503).json({ success: false, message: "Server initializing or database unavailable. Please try again in a moment." });
    }
    next();
};
app.use('/api', checkDbConnection);

const verifyAdmin = async (req, res, next) => {
    console.log("[Middleware Placeholder] Admin authentication assumed successful.");
    return next();
};


// --- 6. API ENDPOINTS (Routes) ---

/**
 * POST /api/register 
 * 🎯 ACTION: Backend prepares verification data (code/token) and returns it.
 * Client then calls SendGrid using this data.
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
        
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        
        const { code, token } = generateVerificationCode(); 

        const newUserDocument = {
            firstName, middleInitial, lastName, studentNo, course, yearLevel, email,
            password: hashedPassword,
            role: "student",
            isVerified: false, 
            verificationCode: code, 
            verificationToken: token, 
            codeExpires: new Date(Date.now() + 15 * 60 * 1000), // 15 mins
            createdAt: new Date(),
        };

        await studentsCollection.insertOne(newUserDocument);
        
        console.log(`✅ User registered (pending verification): ${email}. Verification data prepared for client.`);
        
        // 🔑 RESPONSE: Return all required data for client-side SendGrid call
        res.json({ 
            success: true, 
            message: `Registration successful. Data returned for client-side verification email dispatch.`,
            recipientEmail: email,
            verificationToken: token,
            verificationCode: code
        });

    } catch (error) {
        console.error("❌ Registration Failed:", error);
        
        if (error.code === 11000) {
            let detail = 'A user with this email or student number already exists.';
            if (error.message.includes('studentNo')) {
                detail = 'The **Student Number** is already registered.';
            } else if (error.message.includes('email')) {
                detail = 'The Email is already registered.';
            }
            return res.status(409).json({ success: false, message: detail });
        }
        
        res.status(500).json({ success: false, message: "Server error during registration" });
    }
});


/**
 * POST /api/login-and-sync (No Change)
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
                message: "Account is not verified. Redirecting to verification page.",
                needsVerification: true
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) { 
            return res.status(401).json({ success: false, message: "Invalid email or password." }); 
        }

        let firebaseUid;

        try {
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
 * POST /api/verify-code (No Change)
 */
app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
// ... (The rest of /api/verify-code is unchanged as it only handles database updates and sync)
    if (!email || !code) {
        return res.status(400).json({ success: false, message: "Email and verification code are required." });
    }

    try {
        const user = await studentsCollection.findOne({ email });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (user.isVerified) {
            return res.json({ success: true, message: "Account is already verified." });
        }

        const currentTime = new Date();

        if (user.verificationCode !== code) {
            return res.status(401).json({ success: false, message: "Invalid verification code." });
        }

        if (user.codeExpires && user.codeExpires < currentTime) {
            return res.status(401).json({ success: false, message: "Verification code has expired. Please request a new one." });
        }

        // 1. Verification successful: Update MongoDB
        await studentsCollection.updateOne(
            { email },
            { $set: { isVerified: true }, $unset: { verificationCode: "", verificationToken: "", codeExpires: "" } }
        );

        // 2. Retrieve the verified user object (important for sync function)
        const verifiedUser = await studentsCollection.findOne({ email }); 
        
        // 3. Sync user to Firebase Auth and Firestore 
        if (verifiedUser) {
            await syncUserToFirebase(verifiedUser); 
        }

        console.log(`✅ Account verified by code: ${email}`);
        res.json({ success: true, message: "Account verified successfully! You can now log in." });

    } catch (error) {
        console.error("❌ Code Verification Failed:", error);
        res.status(500).json({ success: false, message: `Server error during code verification and user synchronization: ${error.message}` });
    }
});


/**
 * GET /api/verify-link (No Change)
 */
app.get('/api/verify-link', async (req, res) => {
    const { token, email } = req.query;

    if (!token || !email) {
        return res.status(400).send("Verification failed. Missing token or email.");
    }

    try {
        const user = await studentsCollection.findOne({ email });

        if (!user || user.verificationToken !== token) {
            return res.status(401).send("Verification failed. Invalid or expired link.");
        }
        if (user.isVerified) {
            return res.send("Account is already verified. You can now log in to the portal.");
        }
        
        // 1. Verification successful: Update MongoDB
        await studentsCollection.updateOne(
            { email },
            { $set: { isVerified: true }, $unset: { verificationCode: "", verificationToken: "", codeExpires: "" } }
        );

        // 2. Retrieve the verified user object 
        const verifiedUser = await studentsCollection.findOne({ email });

        // 3. Sync user to Firebase Auth and Firestore 
        if (verifiedUser) {
            await syncUserToFirebase(verifiedUser);
        }

        console.log(`✅ Account verified by link: ${email}`);
        
        // Redirect the user to a success page or provide a friendly message
        res.status(200).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Verification Success</title>
                <style>
                    body { font-family: sans-serif; text-align: center; padding: 50px; }
                    h1 { color: #4CAF50; }
                    .container { max-width: 500px; margin: 0 auto; border: 1px solid #ddd; padding: 30px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Account Verified Successfully!</h1>
                    <p>Your email address (${email}) has been confirmed.</p>
                    <p>You can now close this window and log in to the Scholarship Portal.</p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error("❌ Link Verification Failed:", error);
        res.status(500).send(`Server error during link verification and user synchronization: ${error.message}`);
    }
});


/**
 * POST /api/resend-code
 * 🎯 ACTION: Backend prepares NEW verification data (code/token) and returns it.
 * Client then calls SendGrid using this data.
 */
app.post('/api/resend-code', async (req, res) => {
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
        
        const { code: newCode, token: newToken } = generateVerificationCode();
        
        // Update user document with new code/token and expiration
        await studentsCollection.updateOne(
            { email },
            { 
                $set: { 
                    verificationCode: newCode, 
                    verificationToken: newToken,
                    codeExpires: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
                }
            }
        );

        console.log(`✉️ Resent verification data prepared for client: ${email}`);
        
        // 🔑 RESPONSE: Return all required data for client-side SendGrid call
        res.json({ 
            success: true, 
            message: `New verification data returned for client-side email dispatch.`,
            recipientEmail: email,
            verificationToken: newToken,
            verificationCode: newCode
        });

    } catch (error) {
        console.error("❌ Resend Code Failed:", error);
        res.status(500).json({ success: false, message: "Server error during resend code operation." });
    }
});


/**
 * DELETE /api/admin/delete-student (No Change)
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


// --- 7. INITIALIZATION ---
let serverInitialized = false; 

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
            console.log(`🚀 Server listening on port ${PORT}.`);
            console.log(`Access endpoint via: ${BASE_URL} (if deployed) or http://localhost:${PORT} (if local)`);
            console.log(`Remember to run 'node server.js' to keep this running!`);
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

// Start the initialization process 
initializeServer();