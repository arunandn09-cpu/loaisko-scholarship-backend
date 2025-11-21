const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');

// 🎯 SECURE IMPORT: Firebase Admin SDK
const admin = require('./firebaseAdmin');

// ✅ Email service functions
const {
    generateVerificationCode,
    sendCustomVerificationCodeEmail,
    sendApplicationStatusEmail
} = require('./emailService');

// --- 1. CORE EXPRESS INITIALIZATION ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// --- Helper: Sync user to Firebase ---
async function syncUserToFirebase(user) {
    // ⬇️ UPDATED: Changed middleInitial to middleName
    const { studentNo, email, firstName, middleName, lastName, role, course, yearLevel } = user;
    let firebaseUid = studentNo;

    try {
        const isVerified = user.isVerified || false;

        // Update existing user
        await admin.auth().updateUser(studentNo, {
            email,
            emailVerified: isVerified,
            displayName: `${firstName} ${lastName}`
        });

        console.log(`🔄 Updated Firebase user: ${studentNo}`);
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            const newUser = await admin.auth().createUser({
                uid: studentNo,
                email,
                // NOTE: Password is NOT available here for creation. 
                // This sync function should ideally be called AFTER a successful client-side auth.
                // We'll proceed with the existing structure assuming the studentNo (UID) is known.
                displayName: `${firstName} ${lastName}`
            });
            firebaseUid = newUser.uid;
            console.log(`✅ Created Firebase user: ${newUser.uid}`);
        } else {
            throw new Error(`Firebase sync failed: ${error.message}`);
        }
    }

    // Firestore sync
    try {
        const firestoreDb = admin.firestore();
        await firestoreDb.collection('students').doc(firebaseUid).set({
            firebaseUid,
            studentNo,
            firstName,
            // ⬇️ UPDATED: Changed middleInitial to middleName
            middleName,
            lastName,
            email,
            course,
            yearLevel,
            role,
            verifiedAt: user.isVerified ? admin.firestore.FieldValue.serverTimestamp() : null
        }, { merge: true });
    } catch (firestoreError) {
        console.error("❌ Firestore sync failed:", firestoreError);
    }

    return firebaseUid;
}

// --- MIDDLEWARE ---
const checkDbConnection = (req, res, next) => {
    if (!studentsCollection || !applicationsCollection) {
        return res.status(503).json({ success: false, message: "Server initializing or database unavailable." });
    }
    next();
};
app.use('/api', checkDbConnection);

const verifyAdmin = async (req, res, next) => {
    console.log("[Middleware] Admin authentication assumed. (WARNING: Implement proper authentication for production.)");
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

app.use(cors({
    origin: (origin, callback) => {
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
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

// 1️⃣ REGISTER (This route is likely unused by your client, but updated for consistency)
app.post('/api/register', async (req, res) => {
    // ⬇️ UPDATED: Removed studentNo from destructuring since client no longer provides it 
    // and changed middleInitial to middleName.
    const { firstName, middleName, lastName, course, yearLevel, email, password } = req.body;

    // The client-side register form now handles the Firebase Auth part and uses the UID 
    // as the studentNo. This server route should now primarily handle the MongoDB persistence 
    // and verification if used. We need to generate a studentNo/UID if we use this route.
    // For now, we assume this route is primarily used for the legacy MongoDB flow.
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password required." });
    }

    // Since studentNo is required for MongoDB and Firebase Auth UID, we must generate one.
    // In a real system, this would be a sequence number. We'll use a placeholder UID now.
    // NOTE: This route should be removed or completely refactored if the client is calling Firebase Auth directly.
    const generatedStudentNo = admin.firestore().collection('students').doc().id; 
    
    try {
        if (await studentsCollection.findOne({ email })) {
            return res.status(409).json({ success: false, message: "Email already registered." });
        }

        const verificationCode = generateVerificationCode();
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

        // Create Firebase Auth user using the generated ID
        await admin.auth().createUser({
            uid: generatedStudentNo,
            email,
            password,
            displayName: `${firstName} ${lastName}`,
            emailVerified: false
        });

        const hashedPassword = await bcrypt.hash(password, saltRounds);

        await studentsCollection.insertOne({
            firstName, 
            // ⬇️ UPDATED: Changed middleInitial to middleName
            middleName, 
            lastName, 
            studentNo: generatedStudentNo, // Use generated ID
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
        console.error(error);
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

        const firebaseUid = await syncUserToFirebase(user);
        const token = await admin.auth().createCustomToken(firebaseUid);

        // ⬇️ UPDATED: The user object passed back should match the MongoDB schema
        res.json({
            success: true,
            message: "Login successful.",
            user: {
                studentNo: user.studentNo,
                firebaseUid,
                firstName: user.firstName,
                // ⬇️ UPDATED: Ensure middleName is returned
                middleName: user.middleName || null, 
                lastName: user.lastName,
                email,
                role: user.role
            },
            token
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Login failed." });
    }
});

// 3️⃣ VERIFY CODE (No changes needed)
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

        await studentsCollection.updateOne(
            { email },
            { $set: { isVerified: true, verifiedAt: new Date() }, $unset: { verificationCode: "", codeExpiresAt: "" } }
        );

        await admin.auth().updateUser(user.studentNo, { emailVerified: true });
        await syncUserToFirebase({ ...user, isVerified: true });

        res.json({ success: true, message: "Email verified. You can log in.", userEmail: email });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Verification failed." });
    }
});

// 4️⃣ RESEND VERIFICATION (No changes needed)
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
        console.error(error);
        res.status(500).json({ success: false, message: "Resend failed." });
    }
});

// 5️⃣ ADMIN: SEND STATUS EMAIL (No changes needed)
app.post('/api/send-status-email', verifyAdmin, async (req, res) => {
    const { docId, status, email, name, scholarshipType } = req.body;
    if (!status || !email || !name || !scholarshipType) return res.status(400).json({ success: false, message: "Missing fields." });

    try {
        await sendApplicationStatusEmail(email, name, scholarshipType, status);
        res.json({ success: true, message: `Status email sent to ${email}.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Failed to send status email." });
    }
});

// 6️⃣ ADMIN: DELETE STUDENT (No changes needed)
app.delete('/api/admin/delete-student', verifyAdmin, async (req, res) => {
    const { studentNo, email } = req.body;
    if (!studentNo || !email) return res.status(400).json({ success: false, message: "UID and email required." });

    let mongoDeleted = false, authDeleted = false;

    try {
        const mongoResult = await studentsCollection.deleteOne({ email });
        mongoDeleted = mongoResult.deletedCount > 0;

        // Deleting from Firebase Auth (using studentNo as the UID)
        try { await admin.auth().deleteUser(studentNo); authDeleted = true; } 
        catch (e) { 
            console.warn("Firebase Auth deletion warning:", e.message);
        }

        // Deleting from Firestore (using studentNo as the Document ID)
        try {
            const firestoreDb = admin.firestore();
            await firestoreDb.collection('students').doc(studentNo).delete();
            await firestoreDb.collection('student_profiles').doc(studentNo).delete();
        } 
        catch (e) { 
            console.warn("Firestore deletion warning:", e.message); 
        }

        if (!mongoDeleted && !authDeleted) return res.status(404).json({ success: false, message: "No record found." });

        res.json({ success: true, message: "Student deleted.", mongoDeleted, authDeleted });
    } catch (error) {
        console.error(error);
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