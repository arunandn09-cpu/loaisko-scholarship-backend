// --- 🚨 SENDGRID CREDENTIALS & CONSTANTS ---
// 🚨 1. PASTE YOUR COPIED RESTRICTED SENDGRID API KEY HERE
const SENDGRID_API_KEY = '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'; 
const FROM_EMAIL = 'loaiskoscholarship@gmail.com'; 
const DEPLOYED_URL = 'https://loaiskoportal.web.app'; 
// ------------------------------------------


/**
 * 📧 Sends the Account Verification email using the SendGrid API.
 * This function runs on the client-side (in the browser).
 * @param {object} data - Data returned from server.js (token, code, email).
 * @returns {Promise<Response>} - The promise from the fetch call to SendGrid.
 */
export function sendVerificationEmailClient(data) {
    
    // 1. Construct the complete public verification link
    const verificationLink = `${DEPLOYED_URL}/api/verify-link?token=${data.verificationToken}&email=${data.recipientEmail}`;

    const sendGridPayload = {
        personalizations: [{
            to: [{ email: data.recipientEmail }],
        }],
        from: { email: FROM_EMAIL },
        subject: 'Verify Your Scholarship Portal Account',
        content: [{
            type: 'text/html',
            // 🎯 Adapted HTML structure from your original emailService.js
            value: `
                <h1>Account Verification Required</h1>
                <p>Thank you for registering. Please verify your email address to complete your registration and log in.</p>
                
                <h2>Your Verification Code (6-Digit)</h2>
                <div style="font-size: 24px; font-weight: bold; padding: 10px; background-color: #f4f4f4; display: inline-block; border: 1px solid #ddd; border-radius: 5px; margin-bottom: 20px;">
                    ${data.verificationCode}
                </div>
                
                <p>Alternatively, you can click the link below to verify your account directly:</p>
                <p><a href="${verificationLink}" style="color: #1a73e8; text-decoration: none;">Click Here to Verify Your Email Address</a></p>
                
                <p>The code is valid for 1 minute. If you did not initiate this registration, please ignore this email.</p>
            `
        }]
    };

    return fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SENDGRID_API_KEY}`, 
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(sendGridPayload)
    });
}


/**
 * 📧 Sends the Application Status email using the SendGrid API.
 * @param {string} recipientEmail - The student's email.
 * @param {string} studentName - The student's full name.
 * @param {string} scholarshipType - The scholarship type applied for.
 * @param {string} status - The final status (e.g., "Approved").
 * @returns {Promise<Response>} - The promise from the fetch call to SendGrid.
 */
export function sendApplicationStatusEmailClient(recipientEmail, studentName, scholarshipType, status) {
    const lowerStatus = status.toLowerCase();
    let subject;
    let primaryColor;
    let headerText;
    let bodyContent;

    // --- Switch/Case logic remains the same as your original emailService.js ---
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
            
        // ... (You should include your 'cancelled' and 'pending' cases here) ...
            
        default:
            subject = `ℹ️ Application Status Update: ${status}`;
            primaryColor = '#2196F3';
            headerText = 'Application Status Change';
            bodyContent = `<p>This is to confirm that the status of your application for the <b>${scholarshipType}</b> has been updated to **PENDING**.</p>
                            <p>Your application is currently being reviewed. You will receive another email notification when a final decision has been made.</p>`;
            break;
    }


    const sendGridPayload = {
        personalizations: [{
            to: [{ email: recipientEmail }],
        }],
        from: { email: FROM_EMAIL },
        subject: subject,
        content: [{
            type: 'text/html',
            value: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h1 style="color: ${primaryColor};">${headerText}</h1>
                    <p>Dear ${studentName},</p>
                    ${bodyContent}
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 0.8em; color: #777;">This is an automated notification. Please do not reply to this email.</p>
                </div>
            `
        }]
    };

    return fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SENDGRID_API_KEY}`, 
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(sendGridPayload)
    });
}