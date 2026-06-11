const { initializeApp } = require('firebase/app');
const { getFirestore, collection, query, where, getDocs, doc, updateDoc } = require('firebase/firestore');

const firebaseConfig = {
  projectId: "polla-futbolera-2026-sb",
  appId: "1:1013044061661:web:eaa1639e15fb46bccf0234",
  apiKey: "AIzaSyC07i9gn4HRw8IjIrDJoN504-OZp2SPsTI",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const email = process.argv[2];
if (!email) {
  console.error("Por favor ingresa el correo del usuario. Ejemplo: node scripts/make-admin.js usuario@correo.com");
  process.exit(1);
}

async function makeAdmin() {
  const usersRef = collection(db, "users");
  const q = query(usersRef, where("email", "==", email));
  const snap = await getDocs(q);
  
  if (snap.empty) {
    console.error(`No se encontró ningún usuario con el correo: ${email}`);
    process.exit(1);
  }
  
  const userDoc = snap.docs[0];
  await updateDoc(doc(db, "users", userDoc.id), {
    isAdmin: true
  });
  
  console.log(`¡Éxito! El usuario ${email} ahora es Administrador.`);
  process.exit(0);
}

makeAdmin().catch(err => {
  console.error("Error al asignar admin:", err);
  process.exit(1);
});
