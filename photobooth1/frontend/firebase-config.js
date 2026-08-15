// =========================================================
// Firebase config for the LDR Photobooth project
// =========================================================
const firebaseConfig = {
  apiKey: "AIzaSyACPz6VfIdfzdOfOaJI6dbE1H-0Ir5zz94",
  authDomain: "photobooth-74b0d.firebaseapp.com",
  projectId: "photobooth-74b0d",
  storageBucket: "photobooth-74b0d.firebasestorage.app",
  messagingSenderId: "444767219803",
  appId: "1:444767219803:web:8694dbc9b148a93112cf7e"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();