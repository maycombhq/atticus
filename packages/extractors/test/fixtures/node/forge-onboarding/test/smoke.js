/* eslint-disable */
const { app } = require("../src/app");

app.get("/only-in-tests", () => {});
fetch(`${process.env.BASE_URL}/api/accounts/1`);
