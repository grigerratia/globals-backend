const hoy = new Date();
hoy.setHours(0,0,0,0);

const manana = new Date(hoy);
manana.setDate(manana.getDate() + 1);

console.log("Hoy:", hoy);
console.log("Manana:", manana);
