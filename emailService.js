// emailService.js

const admin = require('./firebaseAdmin'); // Import the initialized Admin SDK
const nodemailer = require('nodemailer');

// --- 🎯 SECURE NODEMAILER SETUP (Credentials from environment) ---
// We keep Nodemailer only for non-Auth emails (Application Status)
const SENDER_EMAIL = process.env.SENDER_EMAIL; 
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Validate that the keys are present
if (!SENDER_EMAIL || !GMAIL_APP_PASSWORD) {
    console.warn("⚠️ Nodemailer credentials (SENDER_EMAIL/GMAIL_APP_PASSWORD) are missing from environment variables. Status emails may fail.");
}

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: SENDER_EMAIL,
        pass: GMAIL_APP_PASSWORD 
    },
    // Removed insecure tls: { rejectUnauthorized: false }
});
// ------------------------------------------------------------


/**
 * Sends a verification email link using the Firebase Admin SDK.
 * @param {string} recipientEmail - The email address to send the verification to.
 * @param {string} frontendRedirectUrl - The base URL where the user will be redirected to handle the verification.
 * @returns {Promise<boolean>} - True if the email was successfully triggered by Firebase.
 */
async function sendFirebaseVerificationEmail(recipientEmail, frontendRedirectUrl) {
    const actionCodeSettings = {
        // This is the URL your FRONTEND will handle after the Firebase server marks the user as verified.
        url: frontendRedirectUrl, 
        handleCodeInApp: false, 
    };

    try {
        // 1. Generate the unique, time-sensitive action link using Firebase Admin SDK
        const link = await admin.auth().generateEmailVerificationLink(
            recipientEmail, 
            actionCodeSettings
        );

        // 2. Use Nodemailer to send the custom email with the link
        const mailOptions = {
            from: `LOAISKOPORTAL Scholarship <${SENDER_EMAIL}>`,
            to: recipientEmail,
            subject: 'Verify Your LOAISKOPORTAL Account',
            html: `
                <h1>Account Verification Required</h1>
                <p>Thank you for registering for the LOAISKOPORTAL. Please verify your email address to complete your registration and log in.</p>
                <p>
                    <a href="${link}" style="color: #1a73e8; text-decoration: none; font-weight: bold;">
                        Click Here to Verify Your Email Address
                    </a>
                </p>
                <p style="font-size: 0.8em; color: #777;">If the button doesn't work, copy and paste the following link into your browser: <br/>${link}</p>
                <p style="font-size: 0.8em; color: #777;">If you did not initiate this registration, please ignore this email.</p>
            `
        };

        let info = await transporter.sendMail(mailOptions);
        console.log(`✉️ Firebase verification link sent via custom SMTP to ${recipientEmail}:`, info.response);
        return true;

    } catch (error) {
        console.error(`❌ FIREBASE LINK GENERATION/EMAIL SEND FAILURE to ${recipientEmail}:`, error.message);
        return false;
    }
}


/**
 * Sends an email confirming the scholarship application status. (STATUS EMAILS ONLY)
 * NOTE: The server passes the exact status string.
 */
async function sendApplicationStatusEmail(recipientEmail, studentName, scholarshipType, status) {
    const lowerStatus = status.toLowerCase();
    let subject, primaryColor, headerText, bodyContent;

    switch (lowerStatus) {
        case 'approved':
            subject = `🎉 Scholarship Application APPROVED!`;
            primaryColor = '#4CAF50';
            headerText = 'Congratulations!';
            bodyContent = `<p>We are pleased to inform you that your application for the <b>${scholarshipType}</b> has been **APPROVED!**</p>
                            <p>You can now log in to the portal to view the details of your award, including the final calculated discount amount.</p>`;
            break;
        case 'rejected':
            subject = `❌ Update on Your Scholarship Application`;
            primaryColor = '#F44336';
            headerText = 'Application Update';
            bodyContent = `<p>We regret to inform you that your application for the <b>${scholarshipType}</b> has been **REJECTED** at this time.</p>
                            <p>You may check the portal for further details or criteria, or contact the administration for clarification.</p>`;
            break;
        case 'cancelled':
            subject = `⚠️ Application Status Update: ${status}`;
            primaryColor = '#FF9800'; 
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to **CANCELLED**.</p>`;
            break;
        case 'pending':
        default:
            subject = `ℹ️ Application Status Update: ${status}`;
            primaryColor = '#2196F3'; 
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to **PENDING**.</p>`;
            break;
    }

    const mailOptions = {
        from: `LOAISKOPORTAL Scholarship <${SENDER_EMAIL}>`,
        to: recipientEmail,
        subject: subject,
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h1 style="color: ${primaryColor};">${headerText}</h1>
                <p>Dear ${studentName},</p>
                ${bodyContent}
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 0.8em; color: #777;">This is an automated notification. Please do not reply to this email.</p>
            </div>
        `
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log(`✉️ Status email (${status}) sent to ${recipientEmail}:`, info.response);
        return true;
    } catch (error) {
        console.error(`❌ STATUS EMAIL SEND FAILURE to ${recipientEmail}:`, error.message);
        return false;
    }
}

module.exports = {
    sendFirebaseVerificationEmail,
    sendApplicationStatusEmail 
};