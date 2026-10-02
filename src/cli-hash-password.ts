import readline from "node:readline/promises";
import { hashPassword } from "./panel/auth.js";

// Uso: npm run hash-password            (te pide la contraseña)
//      npm run hash-password -- "clave" (evita el historial de la terminal si usas la primera forma)
let password = process.argv[2];
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Contraseña del panel (10+ caracteres): ");
  rl.close();
}
if (!password || password.length < 10) {
  console.error("La contraseña debe tener al menos 10 caracteres.");
  process.exit(1);
}
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
