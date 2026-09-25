import fs from 'fs';

let code = fs.readFileSync('src/modules/auth/routes.js', 'utf8');

// The replacement logic:
// 1. In authRouter.post("/login"), instead of generating access token and finishing,
//    generate an OTP, save it, email it, and return { requireOtp: true, email: user.email }.
// 2. In authRouter.post("/verify-otp"), retrieve the user by email, verify OTP,
//    then generate access token and finish (copying the rest of the old /login code).

// Since manipulating text is prone to errors, I'll extract the exact login block to a new file so I can edit it.
const startLogin = code.indexOf('authRouter.post("/login"');
const startReset = code.indexOf('authRouter.post("/validate-reset-token"');
const loginBlock = code.substring(startLogin, startReset);
fs.writeFileSync('loginBlock.txt', loginBlock);
