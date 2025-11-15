const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb'); 
const bcrypt = require('bcrypt');
const admin = require('firebase-admin'); 
const firebase = require('firebase/app'); 

// ✅ UPDATED IMPORT: Includes sendApplicationStatusEmail
const { generateVerificationCode, sendVerificationEmail, sendApplicationStatusEmail } = require('./emailService'); 

// --- 1. CORE EXPRESS INITIALIZATION ---
const app = express();
const PORT = 3000;
// --- END CORE SETUP ---

// --- 2. CONFIGURATION / MIDDLEWARE ---
// 🚨 CRITICAL FIX: Configure CORS to whitelist your live frontend domains.
const allowedOrigins = [
    'http://localhost:3000', // Allow local development
    'https://loaiskoportal.web.app', // ✅ YOUR PRIMARY FIREBASE HOSTING DOMAIN
    'https://loaiskoportal.firebaseapp.com', // ✅ YOUR SECONDARY FIREBASE HOSTING DOMAIN
    'https://loaisko-api-portal.onrender.com' // Include the API host itself, though usually not strictly necessary for client requests, it helps.
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or local requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            console.error(msg, 'Attempted Origin:', origin);
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true, // IMPORTANT: Allows cookies, authorization headers, etc.
}));

app.use(express.json()); 

// 🎯 MONGO DB CONFIG
// NOTE: CORRECTED URI - Removed angle brackets (<>) from around the password.
const uri = "mongodb+srv://ar09_db_userunandn:k6tBypac5gDjylF0@loaiskoportalemailverif.6awvwxe.mongodb.net/?appName=LOAISKOPORTALEmailVerification"; 
const DB_NAME = "scholarship_db"; 
const STUDENTS_COLLECTION = "students"; 
const APPLICATIONS_COLLECTION = "applications"; 

const saltRounds = 10;
const client = new MongoClient(uri);
let studentsCollection; 
let applicationsCollection; 


// --- 5. FIREBASE ADMIN INITIALIZATION ---
// NOTE: This assumes you have the 'firebase-adminsdk.json' file in the same directory.
try {
    // ⚠️ CRITICAL: Ensure 'firebase-adminsdk.json' is in the same folder as server.js
    const serviceAccount = require('./firebase-adminsdk.json');
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin SDK initialized.");
    }
} catch (error) {
    // Note: A "MODULE_NOT_FOUND" error here means the JSON file is missing or misnamed.
    console.error("❌ Firebase Admin Initialization Failed. Ensure 'firebase-adminsdk.json' is present.", error.message);
}


// --- 6. FIREBASE/FIRESTORE SYNC UTILITY (REQUIRED for 'students' collection creation) ---
/**
 * Utility function to sync a verified user to Firebase Auth and Firestore 'students' collection.
 * The Firebase UID is strictly set to the studentNo for linking, and data is synced to the 'students' collection.
 * @param {object} user - The user document retrieved from MongoDB.
* @returns {string} The final Firebase Auth UID used for this user (which is studentNo).
 */
async function syncUserToFirebase(user) {
    const { studentNo, email, firstName, middleInitial, lastName, role, course, yearLevel } = user;
    // Enforcement: The Firebase UID MUST be the studentNo
    let firebaseUid = studentNo; 
    
    // 1. Sync to Firebase Authentication
    try {
        // Try to get by studentNo (which is our desired default UID)
        await admin.auth().getUser(studentNo);
        
        // User exists with studentNo as UID, update necessary fields
        await admin.auth().updateUser(studentNo, {
            email: email,
            emailVerified: true,
            displayName: `${firstName} ${lastName}`,
        });
        console.log(`🔄 Updated existing Firebase Auth user: ${studentNo}`);

    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            // User does not exist, attempt to create new Firebase Auth user
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
                    // 🛑 CRITICAL FIX: If the email already exists, it means the user registered 
                    // with a different UID before the studentNo enforcement was added.
                    console.error(`❌ CRITICAL CONFLICT: Email ${email} is linked to a different Firebase UID. Cannot proceed with studentNo: ${studentNo}. User must be manually merged or deleted.`);
                    throw new Error("Email is already in use by another Firebase account. Contact support for account reset.");
                } else {
                    console.error("❌ Firebase Auth Sync Failed on create:", createError);
                    throw new Error(`Firebase Auth synchronization failed: ${createError.message}`); 
                }
            }
        } else {
            // General error during getUser(studentNo)
            console.error("❌ Firebase Auth Sync Failed on get/update:", error);
            throw new Error(`Firebase Auth synchronization failed: ${error.message}`); 
        }
    }
    
    // 2. Sync data to Firestore 'students' collection
    try {
        const firestoreDb = admin.firestore();
        // 💡 CRITICAL: Use the final determined firebaseUid (which is studentNo) for the Firestore document ID
        const studentProfileRef = firestoreDb.collection('students').doc(firebaseUid); 
        
        // This 'set' operation will **create the 'students' collection** if it doesn't exist.
        await studentProfileRef.set({
            firebaseUid: firebaseUid, // The actual Firebase document ID (studentNo)
            studentNo: studentNo,      // The original ID from MongoDB (for reference)
            firstName,
            middleInitial,
            lastName,
            email, 
            course,
            yearLevel,
            role,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }); // Use merge: true to update fields without overwriting the whole document
        
        console.log(`✅ Synced student profile to Firestore 'students' collection for UID ${firebaseUid}.`);

    } catch (firestoreError) {
        console.error("❌ Firestore Profile Sync Failed:", firestoreError);
        throw new Error(`Firestore profile synchronization failed: ${firestoreError.message}`); 
    }

    return firebaseUid; // Return the UID used to create the token
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


// 🛡️ ADMIN MIDDLEWARE (PLACEHOLDER) 🛡️
const verifyAdmin = async (req, res, next) => {
    // Implement real authentication check (e.g., token verification) here.
    console.log("[Middleware Placeholder] Admin authentication assumed successful.");
    return next();
};


// --- 9. API ENDPOINTS (Routes) ---

/**
 * POST /api/register 
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
        
        // --- Send verification email ---
        const emailSent = await sendVerificationEmail(email, code, token, PORT); 
        
        if (!emailSent) {
            console.error(`❌ FAILED to send verification email for ${email}. Deleting user.`);
            await studentsCollection.deleteOne({ email }); 
            return res.status(500).json({ success: false, message: "Registration failed: Could not send verification email. Please try again later." });
        }
        
        console.log(`✅ User registered (pending verification): ${email}`);
        
        res.json({ 
            success: true, 
            message: `Registration successful. A verification code has been sent to your email (${email}). Please check your inbox (and spam folder) to verify your account and log in.` 
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
 * POST /api/login-and-sync 
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
        
        // Verification check
        if (!user.isVerified) {
            console.warn(`⚠️ Blocked login: User ${email} is not verified.`);
            // Return needsVerification flag for client redirect
            return res.status(403).json({ 
                success: false, 
                message: "Account is not verified. Redirecting to verification page.",
                needsVerification: true // Client will check this flag
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) { 
            return res.status(401).json({ success: false, message: "Invalid email or password." }); 
        }

        // 1. Sync user data and get the final Firebase UID used
        let firebaseUid;

        try {
            // Call the sync function on login to ensure Firebase data is up to date
            firebaseUid = await syncUserToFirebase(user); 
            
            // 2. Generate custom token using the determined UID
            const customToken = await admin.auth().createCustomToken(firebaseUid);


            // 3. Final successful response
            const profileData = {
                studentNo: user.studentNo,
                firebaseUid: firebaseUid, // Add the final UID to the response for client to use
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
            };

            // Send the token under the 'token' key at the root level (which the client expects)
            res.json({ 
                success: true, 
                message: "Login successful.", 
                user: profileData,
                token: customToken // 🔑 CRITICAL: This sends the token to the client.
            });


        } catch (error) {
            // Catch errors from syncUserToFirebase or createCustomToken
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
 * POST /api/verify-code
 */
app.post('/api/verify-code', async (req, res) => {
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
        
        // 3. Sync user to Firebase Auth and Firestore (This creates the 'students' collection if it doesn't exist)
        if (verifiedUser) {
            await syncUserToFirebase(verifiedUser); 
        }

        console.log(`✅ Account verified by code: ${email}`);
        res.json({ success: true, message: "Account verified successfully! You can now log in." });

    } catch (error) {
        console.error("❌ Code Verification Failed:", error);
        // Includes server errors from the new syncUserToFirebase function
        res.status(500).json({ success: false, message: `Server error during code verification and user synchronization: ${error.message}` });
    }
});


/**
 * GET /api/verify-link
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

        // 2. Retrieve the verified user object (important for sync function)
        const verifiedUser = await studentsCollection.findOne({ email });

        // 3. Sync user to Firebase Auth and Firestore (This creates the 'students' collection if it doesn't exist)
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

        // Send the new verification email
        const emailSent = await sendVerificationEmail(email, newCode, newToken, PORT);

        if (!emailSent) {
            return res.status(500).json({ success: false, message: "Failed to send new verification email. Check server logs." });
        }

        console.log(`✉️ Resent verification code to ${email}`);
        res.json({ success: true, message: `A new verification code has been sent to ${email}.` });

    } catch (error) {
        console.error("❌ Resend Code Failed:", error);
        res.status(500).json({ success: false, message: "Server error during resend code operation." });
    }
});


/**
 * POST /api/send-status-email 
 * Endpoint called by the admin page to send status confirmation email.
 */
app.post('/api/send-status-email', verifyAdmin, async (req, res) => {
    // docId is included for logging/debugging
    const { docId, status, email, name, scholarshipType } = req.body; 

    if (!status || !email || !name || !scholarshipType) {
        return res.status(400).json({ 
            success: false, 
            message: "Missing required fields: status, email, name, and scholarshipType are needed to send confirmation." 
        });
    }

    try {
        // Use the imported function: sendApplicationStatusEmail(recipientEmail, studentName, scholarshipType, status)
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
 * DELETE /api/admin/delete-student 
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
            // Use studentNo for deletion as it is the enforced UID
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

        // Deleting related documents from Firestore (studentNo is the Firestore doc ID)
        try {
            const firestoreDb = admin.firestore();
            // Delete document in 'students' collection where ID is studentNo
            await firestoreDb.collection('students').doc(studentNo).delete(); 
            // This second collection 'student_profiles' may be legacy or incorrect, but kept for completeness
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

// Add a flag to prevent double initialization in case of environment issues
let serverInitialized = false; 

/**
 * Connects to the database and starts the Express server.
 */
async function initializeServer() {
    // 🛑 GUARD: Check if the server initialization has already run
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

// Start the initialization process (ONLY ONE CALL IS REQUIRED)
initializeServer();