// emailService.js

const admin = require('./firebaseAdmin'); // Keep the Admin SDK import for token generation
const fetch = require('node-fetch'); // Use built-in node-fetch/axios for simpler API call

// --- 🎯 MAILERSEND SETUP ---
// We will use standard fetch for the code-based email to simplify, 
// as the mailersend SDK seems to require a custom class setup which can be verbose.

// Retrieve credentials from Render Environment Variables
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL; 
// FRONTEND_URL is no longer needed for code-based verification email, but kept for context/other uses

// Validation Check
if (!MAILERSEND_API_KEY || !SENDER_EMAIL) {
    console.error("❌ MAILERSEND/SENDER_EMAIL credentials are missing from environment variables. Email sending will fail.");
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
 * This replaces the broken Firebase link generation.
 * @param {string} recipientEmail - The email address to send the code to.
 * @param {string} code - The 6-digit verification code to include in the email.
 * @returns {Promise<boolean>} - True if the email was successfully sent.
 */
async function sendCustomVerificationCodeEmail(recipientEmail, code) {
    const message = {
        from: { email: SENDER_EMAIL, name: "LOAISKOPORTAL Scholarship" },
        to: [{ email: recipientEmail }],
        subject: "Verification Code for Your Account",
        html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h1 style="color: #003366;">Account Verification Code</h1>
                <p>Thank you for registering. Please use the code below to verify your account in the portal:</p>
                <div style="background-color: #f0f4f8; padding: 20px; text-align: center; border-radius: 8px; margin: 25px 0;">
                    <h2 style="color: #e6c200; margin: 0; font-size: 32px; letter-spacing: 5px;">${code}</h2>
                </div>
                <p>This code is time-sensitive. Please enter it on the verification screen to proceed.</p>
                <p style="font-size: 0.8em; color: #777;">If you did not initiate this registration, please ignore this email.</p>
            </div>
        `,
    };

    try {
        const response = await fetch('https://api.mailersend.com/v1/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MAILERSEND_API_KEY}`,
            },
            body: JSON.stringify(message),
        });

        const result = await response.json();

        if (response.ok) {
            console.log(`✅ Custom verification code sent via MailerSend to ${recipientEmail}`);
            return true;
        } else {
            console.error("❌ MAILERSEND API Error (Status: %s):", response.status, result);
            return false;
        }
    } catch (error) {
        console.error("❌ MailerSend Network Error:", error);
        return false;
    }
}


/**
 * Sends an email confirming the scholarship application status using MailerSend.
 * This function remains UNCHANGED.
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
        const message = {
            from: { email: SENDER_EMAIL, name: "LOAISKOPORTAL Scholarship" },
            to: [{ email: recipientEmail }],
            subject: subject,
            html: htmlTemplate,
        };

        const response = await fetch('https://api.mailersend.com/v1/email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MAILERSEND_API_KEY}`,
            },
            body: JSON.stringify(message),
        });

        if (response.ok) {
            console.log(`✉️ Status email (${status}) sent via MailerSend to ${recipientEmail}`);
            return true;
        } else {
            const errorBody = await response.json();
            console.error(`❌ STATUS EMAIL SEND FAILURE via MailerSend to ${recipientEmail}:`, response.status, errorBody);
            return false;
        }
    } catch (error) {
        console.error(`❌ STATUS EMAIL NETWORK FAILURE to ${recipientEmail}:`, error);
        return false;
    }
}

module.exports = {
    generateVerificationCode, // <-- NEW EXPORT
    sendCustomVerificationCodeEmail, // <-- NEW EXPORT
    sendApplicationStatusEmail 
};