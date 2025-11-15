const crypto = require('crypto');
const nodemailer = require('nodemailer');

// --- 🎯 NODEMAILER SETUP (Reading from secure environment variables) ---
// IMPORTANT: These variables must be set on your Render Dashboard
const SENDER_EMAIL = process.env.SMTP_USER; 
const GMAIL_APP_PASSWORD = process.env.SMTP_PASS;

if (!SENDER_EMAIL || !GMAIL_APP_PASSWORD) {
    console.error("❌ CRITICAL: SMTP_USER or SMTP_PASS environment variables are not set. Email functions will fail.");
    // Exit or throw error if configuration is critical, or just warn if testing locally without env vars
}

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: SENDER_EMAIL,
        pass: GMAIL_APP_PASSWORD 
    },
    // Adding tls setting for potential security issues, though 'secure: true' usually handles this.
    tls: {
        rejectUnauthorized: false
    }
});
// ------------------------------------------------------------


/**
 * Generates a 6-digit verification code and a secure token.
 * @returns {{code: string, token: string}}
 */
function generateVerificationCode() {
    // Generate a 6-digit code for users to manually enter
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Generate a secure, unique token for email link verification
    const token = crypto.randomBytes(32).toString('hex');
    return { code, token };
}

/**
 * Sends a verification email to the user with a code and a verification link.
 * 🎯 MODIFIED: The function now takes 'baseUrl' instead of 'port' to create the link.
 * @param {string} recipientEmail - The email address to send the verification to.
 * @param {string} verificationCode - The 6-digit code.
 * @param {string} verificationToken - The secure token for the link.
 * @param {string} baseUrl - The base URL of the deployed API (e.g., https://loaisko-api-portal.onrender.com).
 * @returns {Promise<boolean>} - True if the email was sent successfully, false otherwise.
 */
async function sendVerificationEmail(recipientEmail, verificationCode, verificationToken, baseUrl) {
    // Using the deployed BASE_URL from server.js for the verification link
    const verificationLink = `${baseUrl}/api/verify-link?token=${verificationToken}&email=${recipientEmail}`;

    const mailOptions = {
        from: `Scholarship Portal <${SENDER_EMAIL}>`,
        to: recipientEmail,
        subject: 'Verify Your Scholarship Portal Account',
        html: `
            <h1>Account Verification Required</h1>
            <p>Thank you for registering. Please verify your email address to complete your registration and log in.</p>
            
            <h2>Your Verification Code (6-Digit)</h2>
            <div style="font-size: 24px; font-weight: bold; padding: 10px; background-color: #f4f4f4; display: inline-block; border: 1px solid #ddd; border-radius: 5px; margin-bottom: 20px;">
                ${verificationCode}
            </div>
            
            <p>Alternatively, you can click the link below to verify your account directly:</p>
            <p><a href="${verificationLink}" style="color: #1a73e8; text-decoration: none;">Click Here to Verify Your Email Address</a></p>
            
            <p>The code is valid for 15 minutes. If you did not initiate this registration, please ignore this email.</p>
        `
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log(`✉️ Verification email sent to ${recipientEmail}:`, info.response);
        return true;
    } catch (error) {
        console.error(`❌ CRITICAL VERIFICATION EMAIL SEND FAILURE to ${recipientEmail}:`, error.message);
        return false;
    }
}


/**
 * Sends an email confirming the scholarship application status (Approved/Rejected/Cancelled/Pending).
 * NOTE: This function remains unchanged as it doesn't need the BASE_URL.
 * @param {string} recipientEmail - The student's email.
 * @param {string} studentName - The student's full name.
 * @param {string} scholarshipType - The scholarship type applied for.
 * @param {string} status - The final status (e.g., "Approved", "Rejected", "Cancelled", "Pending").
 * @returns {Promise<boolean>} - True if the email was sent successfully, false otherwise.
 */
async function sendApplicationStatusEmail(recipientEmail, studentName, scholarshipType, status) {
    const lowerStatus = status.toLowerCase();
    let subject;
    let primaryColor;
    let headerText;
    let bodyContent;

    switch (lowerStatus) {
        case 'approved':
            subject = `🎉 Scholarship Application APPROVED!`;
            primaryColor = '#4CAF50';
            headerText = 'Congratulations!';
            bodyContent = `<p>We are pleased to inform you that your application for the <b>${scholarshipType}</b> has been **APPROVED!**</p>
                           <p>You can now log in to the portal to view the details of your award, including the final calculated discount amount.</p>
                           <p>Please follow the next steps outlined in the portal or contact the administration office.</p>`;
            break;

        case 'rejected':
            subject = `❌ Update on Your Scholarship Application`;
            primaryColor = '#F44336';
            headerText = 'Application Update';
            bodyContent = `<p>We regret to inform you that your application for the <b>${scholarshipType}</b> has been **REJECTED** at this time.</p>
                           <p>You may check the portal for further details or criteria, or contact the administration for clarification.</p>
                           <p>We encourage you to apply again next term if eligible.</p>`;
            break;
            
        case 'cancelled':
            subject = `⚠️ Application Status Update: ${status}`;
            primaryColor = '#FF9800'; // Orange for warning/cancellation
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to **CANCELLED**.</p>
                           <p>This action may have been performed by the administration or by yourself. If you believe this is an error, please contact the administration office immediately.</p>`;
            break;

        case 'pending':
        default:
            subject = `ℹ️ Application Status Update: ${status}`;
            primaryColor = '#2196F3'; // Blue for informational
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to **PENDING**.</p>
                           <p>Your application is currently being reviewed. You will receive another email notification when a final decision has been made.</p>`;
            break;
    }

    const mailOptions = {
        from: `Scholarship Portal <${SENDER_EMAIL}>`,
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
    generateVerificationCode,
    sendVerificationEmail,
    sendApplicationStatusEmail 
};