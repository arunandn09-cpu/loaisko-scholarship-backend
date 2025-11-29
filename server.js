const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');

// 🎯 SECURE IMPORT: Firebase Admin SDK
const admin = require('./firebaseAdmin');

// ☁️ CLOUDINARY CONFIGURATION: READING FROM ENV VARIABLES
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    // IMPORTANT: These keys MUST be set as environment variables on your Render dashboard.
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
});

// ✅ Email service functions
const {
    generateVerificationCode,
    sendCustomVerificationCodeEmail,
    sendApplicationStatusEmail
} = require('./emailService');

// --- 1. CORE EXPRESS INITIALIZATION ---
// NOTE: Increased limit for handling large Base64 document strings
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' })); // ⬅️ IMPORTANT: Increase payload limit
app.use(express.static('public'));

// 🎯 MongoDB CONFIG
const uri = process.env.MONGO_URI;
const DB_NAME = "scholarship_db";
const STUDENTS_COLLECTION = "students";
const APPLICATIONS_COLLECTION = "applications";

const saltRounds = 10;
const client = new MongoClient(uri);
let studentsCollection;
let applicationsCollection;
const firestoreDb = admin.firestore(); // Initialize Firestore instance

// 🔑 Firebase Client Config
const FIREBASE_CLIENT_CONFIG = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

// --- Helper: Sync user to Firebase (Auth & Firestore) ---
/**
 * Synchronizes user data from MongoDB to Firebase Auth and Firestore.
 * @param {Object} user - The user object from MongoDB.
 * @returns {Promise<string>} - The Firebase UID.
 */
async function syncUserToFirebase(user) {
    // MongoDB user's studentNo is used as the Firebase UID
    const firebaseUid = user.studentNo; 
    
    // Ensure data structure matches expected properties
    const { 
        email, 
        firstName, 
        middleName, // middleInitial is now middleName
        lastName, 
        role, 
        course, 
        yearLevel 
    } = user;

    // --- 1. Firebase Auth Sync ---
    try {
        const isVerified = user.isVerified || false;

        // Try to update existing user
        await admin.auth().updateUser(firebaseUid, {
            email,
            emailVerified: isVerified,
            displayName: `${firstName} ${lastName}`
        });

        console.log(`🔄 Updated Firebase Auth user: ${firebaseUid}`);
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            // Create user if not found (NOTE: Password is still missing here)
            await admin.auth().createUser({
                uid: firebaseUid,
                email,
                displayName: `${firstName} ${lastName}`
            });
            console.log(`✅ Created Firebase Auth user: ${firebaseUid}`);
        } else {
            console.error("❌ Firebase Auth sync failed:", error);
        }
    }

    // --- 2. Firestore Sync ---
    try {
        // Use set with merge: true for upserting student data
        await firestoreDb.collection('students').doc(firebaseUid).set({
            studentNo: firebaseUid, // Ensure studentNo field matches UID
            firstName,
            middleName,
            lastName,
            email,
            course,
            yearLevel,
            role,
            verifiedAt: user.isVerified ? admin.firestore.FieldValue.serverTimestamp() : null
        }, { merge: true });
        
        console.log(`✅ Synced user to Firestore: ${firebaseUid}`);
    } catch (firestoreError) {
        console.error("❌ Firestore sync failed:", firestoreError);
    }

    return firebaseUid;
}

// --- CLOUDINARY UPLOAD HELPER WITH PREVIEW FIX ---
/**
 * Uploads a document (Base64 data) to Cloudinary and returns the URL.
 * FIX: Sets resource_type to 'auto' to enable in-browser previewing (PDFs, images) 
 * instead of forcing download.
 * @param {string} fileData - Base64 encoded file string.
 * @param {string} userId - ID of the user (for folder organization).
 * @param {string} docType - Type of document (e.g., 'studentId', 'grades').
 * @returns {Promise<string>} - The secure Cloudinary URL.
 */
async function uploadDocumentToCloudinary(fileData, userId, docType) {
    if (!fileData) throw new Error("File data is required for upload.");

    const publicId = `${userId}/${docType}_${Date.now()}`;

    // 🏆 THE CRITICAL FIX IS HERE: resource_type: 'auto'
    const result = await cloudinary.uploader.upload(fileData, {
        public_id: publicId,
        folder: `application_documents/${userId}`,
        resource_type: 'auto', // ✅ Ensures preview mode for PDFs/Images
        overwrite: true,
        quality: 'auto:low' // Optimization
    });
    
    return result.secure_url;
}

// --- MIDDLEWARE ---
const checkDbConnection = (req, res, next) => {
    if (!studentsCollection || !applicationsCollection) {
        return res.status(503).json({ success: false, message: "Server initializing or database unavailable." });
    }
    next();
};
app.use('/api', checkDbConnection);

/**
 * Middleware to verify Firebase ID Token and attach decoded token to request.
 */
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authorization token not provided.' });
    }
    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("Error verifying token:", error.message);
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
};

const verifyAdmin = async (req, res, next) => {
    // ⚠️ SECURITY WARNING: This bypass must be replaced with a real token validation 
    // using the Firebase Admin SDK for production environments.
    console.log("[Middleware] Admin authentication assumed. (WARNING: Implement proper authentication for production.)");
    // In a real app, you would check req.user.role === 'admin' 
    return next();
};

// --- CORS FIX ---
const allowedOrigins = [
    'https://loaiskoportal.web.app',
    'https://loaiskoportal.firebaseapp.com',
    'http://localhost:3000', 
    'http://localhost:5000',
    'http://127.0.0.1:5500' 
];

// 💡 IMPROVED CORS CONFIGURATION
app.use(cors({
    origin: (origin, callback) => {
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
            // Log the disallowed origin for debugging
            console.warn(`CORS blocked request from origin: ${origin}`);
            callback(new Error('Not allowed by CORS'), false); 
        }
    },
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    credentials: true
}));
// --- END CORS FIX ---

// --- ROUTES ---
app.get('/', (req, res) => res.status(200).json({ message: "LOA ISKO API is running" }));

app.get('/api/firebase-config', (req, res) => res.json(FIREBASE_CLIENT_CONFIG));

// 7️⃣ NEW: DOCUMENT UPLOAD ROUTE
app.post('/api/upload-document', verifyToken, async (req, res) => {
    const { userId, fileData, docType, filename, mimeType } = req.body;

    // Use the verified token's UID for security, not the body's userId
    const authenticatedUserId = req.user.uid; 
    
    if (authenticatedUserId !== userId) {
         return res.status(403).json({ success: false, message: "Unauthorized access attempt for another user's files." });
    }

    if (!userId || !fileData || !docType) {
        return res.status(400).json({ success: false, message: "Missing required file upload parameters." });
    }
    
    // Ensure the file data is properly prefixed for Cloudinary (e.g., "data:image/png;base64,...")
    const prefixedFileData = fileData.startsWith('data:') ? fileData : `${mimeType ? `data:${mimeType}` : 'data:application/octet-stream'};base64,${fileData}`;

    try {
        const fileUrl = await uploadDocumentToCloudinary(prefixedFileData, userId, docType);
        
        // Data structure to save to Firestore's 'applications_files' collection
        const documentInfo = {
            url: fileUrl,
            data: null, // Clear Base64 data once URL is generated
            filename: filename || `${docType}_file`,
            type: mimeType || 'application/octet-stream',
            uploadedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Atomically update the specific document type within the 'documents' map
        const fileDocRef = firestoreDb.collection('applications_files').doc(userId);
        await fileDocRef.set({
            userId: userId,
            documents: {
                [docType]: documentInfo
            }
        }, { merge: true });

        res.json({ 
            success: true, 
            message: `${docType} uploaded successfully.`,
            documentInfo: documentInfo
        });

    } catch (error) {
        console.error(`Cloudinary upload or Firestore update error for ${docType}:`, error);
        res.status(500).json({ success: false, message: `File upload failed for ${docType}.` });
    }
});

// 1️⃣ REGISTER
app.post('/api/register', async (req, res) => {
    // Ensure all required fields are present
    const { firstName, middleName, lastName, course, yearLevel, email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password required." });
    }

    // Use a placeholder UID/studentNo (e.g., Firestore doc ID) since the client doesn't provide it
    const generatedStudentNo = admin.firestore().collection('students').doc().id; 
    
    try {
        // Check for existing user in MongoDB
        if (await studentsCollection.findOne({ email })) {
            return res.status(409).json({ success: false, message: "Email already registered." });
        }

        const verificationCode = generateVerificationCode();
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

        // Create Firebase Auth user
        await admin.auth().createUser({
            uid: generatedStudentNo,
            email,
            password,
            displayName: `${firstName} ${lastName}`,
            emailVerified: false
        });

        // Hash password for MongoDB storage
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Insert into MongoDB
        await studentsCollection.insertOne({
            firstName, 
            middleName, // Updated field name
            lastName, 
            studentNo: generatedStudentNo,
            course, yearLevel, email,
            password: hashedPassword,
            role: "student",
            isVerified: false,
            verificationCode,
            codeExpiresAt,
            createdAt: new Date()
        });

        await sendCustomVerificationCodeEmail(email, verificationCode);

        res.json({ success: true, message: "Registration successful. Verification code sent.", needsVerification: true });
    } catch (error) {
        // Handle Firebase/MongoDB creation errors
        console.error("Registration error:", error);
        res.status(500).json({ success: false, message: "Registration failed." });
    }
});

// 2️⃣ LOGIN & SYNC
app.post('/api/login-and-sync', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required." });

    try {
        const user = await studentsCollection.findOne({ email });
        if (!user) return res.status(401).json({ success: false, message: "Invalid email or password." });
        if (!user.isVerified) return res.status(403).json({ success: false, message: "Account not verified.", needsVerification: true });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid email or password." });

        // Sync MongoDB user data to Firebase Auth and Firestore
        const firebaseUid = await syncUserToFirebase(user);
        
        // Create custom token for client-side Firebase Auth
        const token = await admin.auth().createCustomToken(firebaseUid);

        // Return necessary user data and custom token
        res.json({
            success: true,
            message: "Login successful.",
            user: {
                studentNo: user.studentNo,
                firebaseUid,
                firstName: user.firstName,
                middleName: user.middleName || null, // Ensure middleName is returned
                lastName: user.lastName,
                email,
                role: user.role
            },
            token
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ success: false, message: "Login failed." });
    }
});

// 3️⃣ VERIFY CODE
app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: "Email and code required." });

    try {
        const user = await studentsCollection.findOne({ email });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        if (user.isVerified) return res.json({ success: true, message: "Already verified." });

        const now = new Date();
        if (user.verificationCode !== code) return res.status(400).json({ success: false, message: "Invalid code." });
        if (user.codeExpiresAt && user.codeExpiresAt < now) {
            await studentsCollection.updateOne({ email }, { $unset: { verificationCode: "", codeExpiresAt: "" } });
            return res.status(400).json({ success: false, message: "Code expired. Request new code." });
        }

        // 1. Update MongoDB
        await studentsCollection.updateOne(
            { email },
            { $set: { isVerified: true, verifiedAt: new Date() }, $unset: { verificationCode: "", codeExpiresAt: "" } }
        );

        // 2. Update Firebase Auth and Firestore
        await admin.auth().updateUser(user.studentNo, { emailVerified: true });
        await syncUserToFirebase({ ...user, isVerified: true });

        res.json({ success: true, message: "Email verified. You can log in.", userEmail: email });
    } catch (error) {
        console.error("Verification error:", error);
        res.status(500).json({ success: false, message: "Verification failed." });
    }
});

// 4️⃣ RESEND VERIFICATION
app.post('/api/resend-verification', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required." });

    try {
        const user = await studentsCollection.findOne({ email });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        if (user.isVerified) return res.json({ success: true, message: "Already verified." });

        const newCode = generateVerificationCode();
        const newExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await studentsCollection.updateOne({ email }, { $set: { verificationCode: newCode, codeExpiresAt: newExpiresAt } });
        await sendCustomVerificationCodeEmail(email, newCode);

        res.json({ success: true, message: `New code sent to ${email}.` });
    } catch (error) {
        console.error("Resend verification error:", error);
        res.status(500).json({ success: false, message: "Resend failed." });
    }
});

// 5️⃣ ADMIN: SEND STATUS EMAIL
app.post('/api/send-status-email', verifyAdmin, async (req, res) => {
    const { docId, status, email, name, scholarshipType } = req.body;
    if (!status || !email || !name || !scholarshipType) return res.status(400).json({ success: false, message: "Missing fields." });

    try {
        await sendApplicationStatusEmail(email, name, scholarshipType, status);
        res.json({ success: true, message: `Status email sent to ${email}.` });
    } catch (error) {
        console.error("Send status email error:", error);
        res.status(500).json({ success: false, message: "Failed to send status email." });
    }
});

// 6️⃣ ADMIN: DELETE STUDENT
app.delete('/api/admin/delete-student', verifyAdmin, async (req, res) => {
    const { studentNo, email } = req.body;
    if (!studentNo || !email) return res.status(400).json({ success: false, message: "UID and email required." });

    let mongoDeleted = false, authDeleted = false;

    try {
        // 1. Delete from MongoDB
        const mongoResult = await studentsCollection.deleteOne({ email });
        mongoDeleted = mongoResult.deletedCount > 0;

        // 2. Delete from Firebase Auth (using studentNo as the UID)
        try { 
            await admin.auth().deleteUser(studentNo); 
            authDeleted = true; 
        } 
        catch (e) { 
            console.warn("Firebase Auth deletion warning (user might not exist):", e.message);
        }

        // 3. Delete from Firestore (using studentNo as the Document ID)
        try {
            await firestoreDb.collection('students').doc(studentNo).delete();
            // Assuming 'student_profiles' is another collection keyed by UID
            await firestoreDb.collection('student_profiles').doc(studentNo).delete();
        } 
        catch (e) { 
            console.warn("Firestore deletion warning (doc might not exist):", e.message); 
        }

        if (!mongoDeleted && !authDeleted) return res.status(404).json({ success: false, message: "No record found." });

        res.json({ success: true, message: "Student deleted.", mongoDeleted, authDeleted });
    } catch (error) {
        console.error("Deletion error:", error);
        res.status(500).json({ success: false, message: "Deletion failed." });
    }
});

// --- INITIALIZATION ---
async function initializeServer() {
    if (!uri) {
        console.error("❌ MONGO_URI not set.");
        process.exit(1);
    }

    try {
        await client.connect();
        const db = client.db(DB_NAME);
        studentsCollection = db.collection(STUDENTS_COLLECTION);
        applicationsCollection = db.collection(APPLICATIONS_COLLECTION);
        
        // Ensure indexes exist for fast lookups
        await studentsCollection.createIndex({ studentNo: 1 }, { unique: true });
        await studentsCollection.createIndex({ email: 1 }, { unique: true });

        app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
    } catch (error) {
        console.error("❌ Initialization failed:", error);
        process.exit(1);
    }

    process.on('SIGINT', async () => {
        console.log('\n🛑 Server shutting down. Closing MongoDB connection...');
        await client.close();
        console.log('✅ MongoDB connection closed.');
        process.exit(0);
    });
}

initializeServer();