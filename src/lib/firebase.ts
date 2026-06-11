import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  projectId: "polla-futbolera-2026-sb",
  appId: "1:1013044061661:web:eaa1639e15fb46bccf0234",
  storageBucket: "polla-futbolera-2026-sb.firebasestorage.app",
  apiKey: "AIzaSyC07i9gn4HRw8IjIrDJoN504-OZp2SPsTI",
  authDomain: "polla-futbolera-2026-sb.firebaseapp.com",
  messagingSenderId: "1013044061661",
};

// Initialize Firebase for SSR compatibility
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
