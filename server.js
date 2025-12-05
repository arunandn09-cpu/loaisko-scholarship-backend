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
 */
async function syncUserToFirebase(user) {
    const firebaseUid = user.studentNo; 
    
    const { 
        email, 
        firstName, 
        middleName, 
        lastName, 
        role, 
        course, 
        yearLevel 
    } = user;

    // --- 1. Firebase Auth Sync ---
    try {
        const isVerified = user.isVerified || false;
        await admin.auth().updateUser(firebaseUid, {
            email,
            emailVerified: isVerified,
            displayName: `${firstName} ${lastName}`
        });
        console.log(`🔄 Updated Firebase Auth user: ${firebaseUid}`);
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
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
        await firestoreDb.collection('students').doc(firebaseUid).set({
            studentNo: firebaseUid, 
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

// --- 🏆 CRITICAL UPDATE: CLOUDINARY UPLOAD HELPER WITH OCR INTEGRATION ---
/**
 * Uploads a document (Base64 data) to Cloudinary, runs OCR if needed, and returns 
 * the URL and OCR result.
 * @param {string} fileData - Base64 encoded file string.
 * @param {string} userId - ID of the user (for folder organization).
 * @param {string} docType - Type of document (e.g., 'certificateOfGrades', 'studentId').
 * @returns {Promise<{url: string, ocr_result: Object|null}>} - The URL and OCR data.
 */
async function uploadDocumentToCloudinary(fileData, userId, docType) {
    if (!fileData) throw new Error("File data is required for upload.");

    const publicId = `${userId}/${docType}_${Date.now()}`;
    let ocrResult = null;
    let explicitEager = [];
    let resourceType = 'auto'; // Default for flexibility

    // 🏆 OCR LOGIC: Only run Advanced OCR on documents that require verification/data extraction
    if (docType === 'certificateOfGrades' || docType === 'grades') {
        // Add the Advanced OCR instruction
        explicitEager.push({ raw_convert: 'adv_ocr' });
        // NOTE: Cloudinary sometimes requires resource_type to be 'image' for OCR on PDFs/docs
        resourceType = 'image'; 
    }

    // 1. Upload the file and optionally run OCR as an 'eager' transformation
    const result = await cloudinary.uploader.upload(fileData, {
        public_id: publicId,
        folder: `application_documents/${userId}`,
        resource_type: resourceType, // Use 'image' for OCR, 'auto' otherwise
        overwrite: true,
        quality: 'auto:low', // Optimization
        eager: explicitEager, // Run OCR during upload if requested
    });
    
    // 2. Extract OCR data from the response if it was requested
    if (result.eager && result.eager.length > 0) {
        const ocrData = result.eager.find(e => e.raw_convert === 'adv_ocr');
        if (ocrData && ocrData.response) {
            try {
                // The response is a stringified JSON (text/plain output), parse it 
                // to save as a Firestore Map.
                ocrResult = JSON.parse(ocrData.response); 
            } catch (e) {
                console.warn("Could not parse OCR response JSON:", e);
                // If parsing fails, try saving the raw response string
                ocrResult = ocrData.response; 
            }
        }
    }
    
    return {
        url: result.secure_url,
        ocr_result: ocrResult // <-- The OCR result is now returned
    };
}


/**
 * Saves the Cloudinary URL and metadata to the dedicated applications_files collection.
 * 🟢 MODIFIED: Accepts applicationId for better indexing and retrieval.
 */
async function saveApplicationFilesToFirestore(applicationId, documents) { 
    // This function should save documents keyed by the application ID, not the user ID, 
    // as an app ID is unique for each application submission.
    const fileDocRef = firestoreDb.collection('applications_files').doc(applicationId); 
    await fileDocRef.set({
        applicationId: applicationId,
        documents: documents,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }); 
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
    // and role check for production environments.
    return next(); // Temporarily bypass for local admin testing
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

// 7️⃣ DOCUMENT UPLOAD ROUTE (Standalone - for individual file submissions)
app.post('/api/upload-document', verifyToken, async (req, res) => {
    const { userId, fileData, docType, filename, mimeType } = req.body;
    const authenticatedUserId = req.user.uid; 
    
    if (authenticatedUserId !== userId) {
        return res.status(403).json({ success: false, message: "Unauthorized access attempt for another user's files." });
    }

    if (!userId || !fileData || !docType) {
        return res.status(400).json({ success: false, message: "Missing required file upload parameters." });
    }
    
    const prefixedFileData = fileData.startsWith('data:') ? fileData : `${mimeType ? `data:${mimeType}` : 'data:application/octet-stream'};base64,${fileData}`;
    
    // Generate a temporary application ID for standalone document updates
    const tempApplicationId = req.body.applicationId || userId; 
    
    try {
        // 🏆 CRITICAL CHANGE: Get URL AND OCR result
        const { url: fileUrl, ocr_result } = await uploadDocumentToCloudinary(prefixedFileData, userId, docType);
        
        // Data structure to save to Firestore's 'applications_files' collection
        const documentInfo = {
            url: fileUrl,
            ocr_result: ocr_result, // <-- OCR result is now included here
            filename: filename || `${docType}_file`,
            type: mimeType || 'application/octet-stream',
            uploadedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Atomically update the specific document type within the 'documents' map
        // 🟢 FIX: Use a better ID for single document uploads, often still keyed by User ID if not part of an application
        const fileDocRef = firestoreDb.collection('applications_files').doc(userId); 
        await fileDocRef.set({
            userId: userId,
            documents: {
                [docType]: documentInfo
            }
        }, { merge: true });

        res.json({ 
            success: true, 
            message: `${docType} uploaded successfully. OCR status: ${ocr_result ? 'Processed' : 'N/A'}`,
            documentInfo: documentInfo
        });

    } catch (error) {
        console.error(`Cloudinary upload or Firestore update error for ${docType}:`, error);
        res.status(500).json({ success: false, message: `File upload failed for ${docType}.` });
    }
});

// 8️⃣ APPLICATION SUBMISSION ROUTE (Handles all data + uploads)
app.post('/api/submit-application', verifyToken, async (req, res) => {
    const { 
        userId, 
        studentId, 
        applicationData, 
        documents: documentsToUpload 
    } = req.body;

    const authenticatedUserId = req.user.uid; 
    
    if (authenticatedUserId !== userId || authenticatedUserId !== studentId) {
        return res.status(403).json({ success: false, message: "Unauthorized submission: User ID mismatch." });
    }
    
    if (!applicationData || !documentsToUpload) {
        return res.status(400).json({ success: false, message: "Missing application data or documents." });
    }
    
    let uploadedDocuments = {};
    const newAppRef = firestoreDb.collection('scholarship_applications').doc(); 
    const applicationId = newAppRef.id;

    try {
        // --- 1. Upload Documents to Cloudinary (with OCR) ---
        for (const docType in documentsToUpload) {
            const { fileData, filename, mimeType } = documentsToUpload[docType];
            
            if (fileData) {
                const prefixedFileData = fileData.startsWith('data:') ? fileData : `${mimeType ? `data:${mimeType}` : 'data:application/octet-stream'};base64,${fileData}`;
                
                // 🏆 CRITICAL CHANGE: Call the updated helper to get URL AND OCR result
                const { url: fileUrl, ocr_result } = await uploadDocumentToCloudinary(prefixedFileData, userId, docType);
                
                uploadedDocuments[docType] = {
                    url: fileUrl,
                    ocr_result: ocr_result, // <-- OCR result is now included
                    filename: filename || `${docType}_file`,
                    type: mimeType || 'application/octet-stream',
                    uploadedAt: admin.firestore.FieldValue.serverTimestamp()
                };
            }
        }
        
        // --- 2. Save Document URLs and OCR Data to applications_files collection ---
        // 🟢 FIX: Pass the applicationId
        await saveApplicationFilesToFirestore(applicationId, uploadedDocuments); 

        // --- 3. Save Main Application Data to scholarship_applications collection ---
        const finalApplicationData = {
            ...applicationData,
            applicationId: applicationId, 
            userId,
            studentId, 
            middleName: applicationData.middleName || null,
            status: applicationData.status || "Submitted",
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await newAppRef.set(finalApplicationData);
        
        // --- 4. Update the current_application tracker in Firestore ---
        await firestoreDb.collection('current_application').doc(userId).set({
            applicationId: applicationId,
            status: finalApplicationData.status,
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
            scholarshipType: finalApplicationData.scholarshipType
        });


        res.status(200).json({
            success: true,
            message: "Application, documents, and OCR analysis submitted successfully.",
            applicationId: applicationId,
            applicationData: finalApplicationData, 
        });

    } catch (error) {
        console.error("💥 Application submission failed with Cloudinary/Firestore error:", error); 
        res.status(500).json({ 
            success: false, 
            message: "Application submission failed due to a server or file upload error.",
            errorDetails: error.message 
        });
    }
});

// 1️⃣ REGISTER
app.post('/api/register', async (req, res) => {
    const { firstName, middleName, lastName, course, yearLevel, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required." });

    const generatedStudentNo = admin.firestore().collection('students').doc().id; 
    
    try {
        if (await studentsCollection.findOne({ email })) return res.status(409).json({ success: false, message: "Email already registered." });

        const verificationCode = generateVerificationCode();
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

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
            middleName, 
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

        const firebaseUid = await syncUserToFirebase(user);
        const token = await admin.auth().createCustomToken(firebaseUid);

        res.json({
            success: true,
            message: "Login successful.",
            user: {
                studentNo: user.studentNo,
                firebaseUid,
                firstName: user.firstName,
                middleName: user.middleName || null, 
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

        await studentsCollection.updateOne(
            { email },
            { $set: { isVerified: true, verifiedAt: new Date() }, $unset: { verificationCode: "", codeExpiresAt: "" } }
        );

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

        // 2. Delete from Firebase Auth
        try { 
            await admin.auth().deleteUser(studentNo); 
            authDeleted = true; 
        } 
        catch (e) { 
            console.warn("Firebase Auth deletion warning (user might not exist):", e.message);
        }

        // 3. Delete from Firestore
        try {
            await firestoreDb.collection('students').doc(studentNo).delete();
            await firestoreDb.collection('student_profiles').doc(studentNo).delete();
            await firestoreDb.collection('applications_files').doc(studentNo).delete(); 
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