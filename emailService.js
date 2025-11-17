// emailService.js

const admin = require('./firebaseAdmin'); // Import the initialized Admin SDK

// --- 🎯 MAILERSEND SETUP ---
// Install: npm install mailersend
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");

// Retrieve credentials from Render Environment Variables
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL; 
const FRONTEND_URL = process.env.FRONTEND_URL; // For generating the redirect URL

// Validation Check
if (!MAILERSEND_API_KEY || !SENDER_EMAIL || !FRONTEND_URL) {
    console.error("❌ MAILERSEND/URL credentials (MAILERSEND_API_KEY, SENDER_EMAIL, FRONTEND_URL) are missing from environment variables. Email sending will fail.");
}

const mailersend = new MailerSend({
    apiKey: MAILERSEND_API_KEY,
});
// The Sender object defines the 'From' email address and name
const sender = new Sender(SENDER_EMAIL, "LOAISKOPORTAL Scholarship");

// --- Removed all Nodemailer/GMAIL_APP_PASSWORD setup and related warnings ---

/**
 * Sends a verification email link using the Firebase Admin SDK to generate the secure link, 
 * but uses MailerSend to send the email.
 * * @param {string} recipientEmail - The email address to send the verification to.
 * @returns {Promise<boolean>} - True if the email was successfully sent via MailerSend.
 */
async function sendFirebaseVerificationEmail(recipientEmail) {
    // The redirect URL is constructed using the base FRONTEND_URL environment variable
    const frontendRedirectUrl = `${FRONTEND_URL}/verify-email`; 
    
    const actionCodeSettings = {
        // This is the URL your FRONTEND will handle after the Firebase server marks the user as verified.
        url: frontendRedirectUrl, 
        handleCodeInApp: false, // Ensures verification happens in a browser tab, not within the app
    };

    try {
        // 1. Generate the unique, time-sensitive action link using Firebase Admin SDK
        const link = await admin.auth().generateEmailVerificationLink(
            recipientEmail, 
            actionCodeSettings
        );

        // 2. Prepare the email content for MailerSend
        const recipient = new Recipient(recipientEmail);
        
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h1>Account Verification Required</h1>
                <p>Thank you for registering for the LOAISKOPORTAL. Please verify your email address to complete your registration and log in.</p>
                <p style="margin-top: 25px;">
                    <a href="${link}" style="color: #ffffff; background-color: #1a73e8; padding: 10px 20px; border-radius: 5px; text-decoration: none; font-weight: bold;">
                        Click Here to Verify Your Email Address
                    </a>
                </p>
                <p style="font-size: 0.8em; color: #777; margin-top: 20px;">If the button doesn't work, copy and paste the following link into your browser: <br/><a href="${link}">${link}</a></p>
                <p style="font-size: 0.8em; color: #777;">If you did not initiate this registration, please ignore this email.</p>
            </div>
        `;

        const emailParams = new EmailParams()
            .setFrom(sender)
            .setTo([recipient])
            .setSubject('Verify Your LOAISKOPORTAL Account')
            .setHtml(htmlContent);

        // 3. Send the email using MailerSend SDK
        await mailersend.email.send(emailParams);
        
        console.log(`✉️ Firebase verification link successfully sent via MailerSend to ${recipientEmail}`);
        return true;

    } catch (error) {
        console.error(`❌ FIREBASE LINK GENERATION/MAILERSEND FAILURE to ${recipientEmail}:`, error.message, error.response?.data);
        return false;
    }
}


/**
 * Sends an email confirming the scholarship application status using MailerSend.
 * NOTE: The server passes the exact status string.
 */
async function sendApplicationStatusEmail(recipientEmail, studentName, scholarshipType, status) {
    const lowerStatus = status.toLowerCase();
    let subject, primaryColor, headerText, bodyContent;

    // --- Status Logic (Kept the same) ---
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
    // --- End Status Logic ---

    const htmlTemplate = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h1 style="color: ${primaryColor};">${headerText}</h1>
            <p>Dear ${studentName},</p>
            ${bodyContent}
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 0.8em; color: #777;">This is an automated notification. Please do not reply to this email.</p>
        </div>
    `;

    try {
        const recipient = new Recipient(recipientEmail);
        
        const emailParams = new EmailParams()
            .setFrom(sender)
            .setTo([recipient])
            .setSubject(subject)
            .setHtml(htmlTemplate);

        // Send the email using MailerSend SDK
        await mailersend.email.send(emailParams);
        
        console.log(`✉️ Status email (${status}) sent via MailerSend to ${recipientEmail}`);
        return true;
        
    } catch (error) {
        console.error(`❌ STATUS EMAIL SEND FAILURE via MailerSend to ${recipientEmail}:`, error.message, error.response?.data);
        return false;
    }
}

module.exports = {
    sendFirebaseVerificationEmail,
    sendApplicationStatusEmail 
};