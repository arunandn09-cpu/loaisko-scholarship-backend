const admin = require('./firebaseAdmin'); 
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');

// --- 🎯 MAILERSEND SETUP ---
// Initialize MailerSend client using the environment variable
// The environment variable MUST be named MAILERSEND_API_KEY.
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY;

// ⚠️ IMPORTANT: You need to install the MailerSend SDK: npm install mailersend
const mailersend = MAILERSEND_API_KEY ? new MailerSend({
    apiKey: MAILERSEND_API_KEY,
}) : null;

// SENDER_EMAIL must be set to a verified email (e.g., loaiskoportal@alabangscholarship.info)
const SENDER_EMAIL = process.env.SENDER_EMAIL; 

// Validation Check
if (!MAILERSEND_API_KEY) {
    console.error("❌ MAILERSEND_API_KEY is missing from environment variables. Email sending will fail.");
}
if (!SENDER_EMAIL) {
    console.error("❌ SENDER_EMAIL is missing from environment variables. Email sending will fail.");
}
if (!mailersend) {
    console.warn("⚠️ MailerSend client is not initialized due to missing API key.");
}


/**
 * Generates a random 6-digit numeric verification code.
 * @returns {string} - The 6-digit code.
 */
function generateVerificationCode() {
    // Generate a number between 100000 and 999999 (inclusive)
    return Math.floor(100000 + Math.random() * 900000).toString();
}


/**
 * Sends a custom 6-digit verification code via MailerSend.
 * @param {string} recipientEmail - The email address to send the code to.
 * @param {string} code - The 6-digit verification code to include in the email.
 * @returns {Promise<boolean>} - True if the email was successfully sent.
 */
async function sendCustomVerificationCodeEmail(recipientEmail, code) {
    if (!mailersend || !SENDER_EMAIL) {
        console.error("MailerSend service not ready. Cannot send verification email.");
        return false;
    }
    
    // 1. Define Sender and Recipient
    const sender = new Sender(SENDER_EMAIL, "LOAISKOPORTAL Scholarship");
    const recipients = [new Recipient(recipientEmail)];

    // 2. Define HTML content
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; border: 1px solid #e6c200; border-radius: 8px;">
            <h1 style="color: #003366;">Account Verification Code</h1>
            <p>Thank you for registering. Please use the code below to verify your account in the portal:</p>
            <div style="background-color: #f0f4f8; padding: 20px; text-align: center; border-radius: 8px; margin: 25px 0;">
                <h2 style="color: #e6c200; margin: 0; font-size: 32px; letter-spacing: 5px;">${code}</h2>
            </div>
            <p>This code is time-sensitive. Please enter it on the verification screen to proceed.</p>
            <p style="font-size: 0.8em; color: #777;">If you did not initiate this registration, please ignore this email.</p>
        </div>
    `;

    // 3. Build Email Parameters
    const emailParams = new EmailParams()
        .setFrom(sender)
        .setTo(recipients)
        .setSubject("Verification Code for Your Account")
        .setHtml(htmlContent)
        .setText(`Your verification code is: ${code}. This code is time-sensitive.`);

    try {
        // 4. Send the email
        await mailersend.email.send(emailParams);

        console.log(`✅ Custom verification code sent via MailerSend to ${recipientEmail}.`);
        return true;
    } catch (error) {
        // Log the error response data if available for better debugging
        console.error("❌ MailerSend SDK Network/Sending Error:", error.response?.data || error);
        return false;
    }
}


/**
 * Sends an email confirming the scholarship application status using MailerSend.
 * @param {string} recipientEmail - The student's email.
 * @param {string} studentName - The student's name.
 * @param {string} scholarshipType - The type of scholarship applied for.
 * @param {string} status - The application status (Approved, Rejected, Pending, Cancelled).
 * @returns {Promise<boolean>} - True if the email was successfully sent.
 */
async function sendApplicationStatusEmail(recipientEmail, studentName, scholarshipType, status) {
    if (!mailersend || !SENDER_EMAIL) {
        console.error("MailerSend service not ready. Cannot send application status email.");
        return false;
    }

    const lowerStatus = status.toLowerCase();
    let subject, primaryColor, headerText, bodyContent;

    // --- Status Logic ---
    switch (lowerStatus) {
        case 'approved':
            subject = `🎉 Scholarship Application APPROVED!`;
            primaryColor = '#4CAF50';
            headerText = 'Congratulations!';
            bodyContent = `<p>We are pleased to inform you that your application for the <b>${scholarshipType}</b> has been <strong>APPROVED!</strong></p>
                            <p>You can now log in to the portal to view the details of your award, including the final calculated discount amount.</p>`;
            break;
        case 'rejected':
            subject = `❌ Update on Your Scholarship Application`;
            primaryColor = '#F44336';
            headerText = 'Application Update';
            bodyContent = `<p>We regret to inform you that your application for the <b>${scholarshipType}</b> has been <strong>REJECTED</strong> at this time.</p>
                            <p>You may check the portal for further details or criteria, or contact the administration for clarification.</p>`;
            break;
        case 'cancelled':
            subject = `⚠️ Application Status Update: ${status}`;
            primaryColor = '#FF9800'; 
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to <strong>CANCELLED</strong>.</p>`;
            break;
        case 'pending':
        default:
            subject = `ℹ️ Application Status Update: ${status}`;
            primaryColor = '#2196F3'; 
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to <strong>PENDING</strong>.</p>`;
            break;
    }
    // --- End Status Logic ---

    const htmlTemplate = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h1 style="color: ${primaryColor};">${headerText}</h1>
            <p>Dear ${studentName},</p>
            ${bodyContent}
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 0.8em; color: #777;">This is an automated notification. Please do not reply to this email.</p>
        </div>
    `;
    
    // 1. Define Sender and Recipient
    const sender = new Sender(SENDER_EMAIL, "LOAISKOPORTAL Scholarship");
    const recipients = [new Recipient(recipientEmail)];

    // 2. Build Email Parameters
    const emailParams = new EmailParams()
        .setFrom(sender)
        .setTo(recipients)
        .setSubject(subject)
        .setHtml(htmlTemplate)
        .setText(`Dear ${studentName}, your application status for the ${scholarshipType} is now ${status}.`); // Plain text fallback

    try {
        // 3. Send the email
        await mailersend.email.send(emailParams);
        
        console.log(`✉️ Status email (${status}) sent via MailerSend to ${recipientEmail}.`);
        return true;
        
    } catch (error) {
        // Log the error response data if available for better debugging
        console.error(`❌ STATUS EMAIL SEND FAILURE via MailerSend to ${recipientEmail}:`, error.response?.data || error);
        return false;
    }
}

module.exports = {
    generateVerificationCode,
    sendCustomVerificationCodeEmail,
    sendApplicationStatusEmail 
};