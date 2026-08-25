import express from "express";

const app = express();
app.use(express.json());

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id, name: "Ada Lovelace" });
});

app.post("/reports", (req, res) => {
  res.status(201).json({ reportId: "rep_123", status: "queued" });
});

app.get("/weather", (req, res) => {
  res.json({ forecast: "sunny", tempF: 72 });
});

app.listen(3000, () => {
  console.log("listening on :3000");
});
