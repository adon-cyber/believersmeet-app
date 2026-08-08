// firebase-config.js
// Firebase v10+ Modular SDK Configuration

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Replace with your actual Firebase project credentials
const firebaseConfig = {
  apiKey: "AIzaSyBwEcqaYSOvfEqsrNebFY_3ef0CkmQ1zcg",
  authDomain: "believersmeet-app.firebaseapp.com",
  projectId: "believersmeet-app",
  storageBucket: "believersmeet-app.firebasestorage.app",
  messagingSenderId: "950754781573",
  appId: "1:950754781573:web:e69112b5ace0dc44d8fcec",
  measurementId: "G-4XFQBVJ68B"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication and Firestore
const auth = getAuth(app);
const db = getFirestore(app);

// Attach globally for legacy script compatibility if needed
window.firebaseApp = app;
window.firebaseAuth = auth;
window.firebaseDb = db;

console.log("Firebase App, Auth, and Firestore initialized successfully.");

export { app, auth, db };
