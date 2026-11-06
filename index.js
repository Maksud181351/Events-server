import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 5000;

/* ---------- Middleware ---------- */
app.use(
  cors({
    origin: [process.env.CLIENT_URL, "http://localhost:3000"],
    credentials: true,
  })
);
app.use(express.json());

/* ---------- MongoDB (serverless-friendly cached connection) ---------- */
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  await client.connect();
  cachedDb = client.db(process.env.DB_NAME || "events-db");
  return cachedDb;
}
const eventsCol = async () => (await getDb()).collection("events");
const joinsCol = async () => (await getDb()).collection("joinedEvents");

/* ---------- Helpers ---------- */
const todayStr = () => new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
const isValidId = (id) => ObjectId.isValid(id);

/* ---------- JWT middleware (BetterAuth JWKS) ---------- */
let JWKS;
const getJWKS = () => {
  if (!JWKS) {
    JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));
  }
  return JWKS;
};

async function verifyJWT(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized: token nai" });
  try {
    const { payload } = await jwtVerify(token, getJWKS());
    req.user = payload; // payload.email, payload.name thakbe
    next();
  } catch (err) {
    console.error("JWT error:", err.message);
    return res.status(401).send({ message: "Unauthorized: token valid na" });
  }
}

/* ---------- Validation ---------- */
function validateEvent(body) {
  const { title, description, eventType, thumbnail, location, eventDate } = body;
  if (!title || title.trim().length < 5) return "Title komport 5 character er hote hobe";
  if (!description || description.trim().length < 20) return "Description komport 20 character er hote hobe";
  if (!eventType) return "Event type select koro";
  if (!thumbnail || !/^https?:\/\/.+/.test(thumbnail)) return "Valid thumbnail URL dao";
  if (!location || location.trim().length < 3) return "Location dao";
  if (!eventDate) return "Event date dao";
  if (eventDate <= todayStr()) return "Event date obossoi future er hote hobe";
  return null;
}

/* ---------- Routes ---------- */
app.get("/", (req, res) => res.send({ message: "Social Events API is running" }));

/* ===== PUBLIC: Events ===== */

// Home page: recent upcoming events (limit)
app.get("/events/upcoming", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 6;
    const result = await (await eventsCol())
      .find({ eventDate: { $gte: todayStr() } })
      .sort({ eventDate: 1 })
      .limit(limit)
      .toArray();
    res.send(result);
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

// Upcoming events page (search + type filter)
app.get("/events", async (req, res) => {
  try {
    const { search, type } = req.query;
    const query = { eventDate: { $gte: todayStr() } };
    if (search) query.title = { $regex: search, $options: "i" };
    if (type && type !== "all") query.eventType = type;

    const result = await (await eventsCol()).find(query).sort({ eventDate: 1 }).toArray();
    res.send(result);
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

// Single event details
app.get("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).send({ message: "Invalid event id" });
    const event = await (await eventsCol()).findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).send({ message: "Event pawa jayni" });
    res.send(event);
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

/* ===== PROTECTED: Events ===== */

// Create event
app.post("/events", verifyJWT, async (req, res) => {
  try {
    const error = validateEvent(req.body);
    if (error) return res.status(400).send({ message: error });

    const { title, description, eventType, thumbnail, location, eventDate } = req.body;
    const doc = {
      title: title.trim(),
      description: description.trim(),
      eventType,
      thumbnail,
      location: location.trim(),
      eventDate,
      creatorEmail: req.user.email, // token theke, body theke na
      creatorName: req.user.name || "Anonymous",
      createdAt: new Date(),
    };
    const result = await (await eventsCol()).insertOne(doc);
    res.status(201).send(result);
  } catch (e) {
    res.status(500).send({ message: "Event create kora jayni" });
  }
});

// My events (manage page)
app.get("/my-events", verifyJWT, async (req, res) => {
  try {
    const result = await (await eventsCol())
      .find({ creatorEmail: req.user.email })
      .sort({ eventDate: 1 })
      .toArray();
    res.send(result);
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

// Update event (owner only)
app.put("/events/:id", verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).send({ message: "Invalid event id" });

    const col = await eventsCol();
    const event = await col.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).send({ message: "Event pawa jayni" });
    if (event.creatorEmail !== req.user.email)
      return res.status(403).send({ message: "Forbidden: eta tomar event na" });

    const error = validateEvent(req.body);
    if (error) return res.status(400).send({ message: error });

    const { title, description, eventType, thumbnail, location, eventDate } = req.body;
    const result = await col.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          title: title.trim(),
          description: description.trim(),
          eventType,
          thumbnail,
          location: location.trim(),
          eventDate,
          updatedAt: new Date(),
        },
      }
    );
    res.send(result);
  } catch (e) {
    res.status(500).send({ message: "Update kora jayni" });
  }
});

// Delete event (owner only)
app.delete("/events/:id", verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).send({ message: "Invalid event id" });

    const col = await eventsCol();
    const event = await col.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).send({ message: "Event pawa jayni" });
    if (event.creatorEmail !== req.user.email)
      return res.status(403).send({ message: "Forbidden: eta tomar event na" });

    const result = await col.deleteOne({ _id: new ObjectId(id) });
    await (await joinsCol()).deleteMany({ eventId: id });
    res.send(result);
  } catch (e) {
    res.status(500).send({ message: "Delete kora jayni" });
  }
});

/* ===== PROTECTED: Joins ===== */

// Join an event
app.post("/joins", verifyJWT, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!isValidId(eventId)) return res.status(400).send({ message: "Invalid event id" });

    const event = await (await eventsCol()).findOne({ _id: new ObjectId(eventId) });
    if (!event) return res.status(404).send({ message: "Event pawa jayni" });
    if (event.eventDate < todayStr())
      return res.status(400).send({ message: "Ei event shesh hoye gese" });

    const col = await joinsCol();
    const already = await col.findOne({ eventId, userEmail: req.user.email });
    if (already) return res.status(409).send({ message: "Tumi already ei event e join koreso" });

    const doc = {
      eventId,
      userEmail: req.user.email,
      userName: req.user.name || "Anonymous",
      eventTitle: event.title,
      eventThumbnail: event.thumbnail,
      eventLocation: event.location,
      eventType: event.eventType,
      eventDate: event.eventDate,
      joinedAt: new Date(),
    };
    const result = await col.insertOne(doc);
    res.status(201).send(result);
  } catch (e) {
    res.status(500).send({ message: "Join kora jayni" });
  }
});

// Joined events (sorted by event date)
app.get("/joins", verifyJWT, async (req, res) => {
  try {
    const result = await (await joinsCol())
      .find({ userEmail: req.user.email })
      .sort({ eventDate: 1 })
      .toArray();
    res.send(result);
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

// User ei event e already joined kina
app.get("/joins/check/:eventId", verifyJWT, async (req, res) => {
  try {
    const found = await (await joinsCol()).findOne({
      eventId: req.params.eventId,
      userEmail: req.user.email,
    });
    res.send({ joined: !!found });
  } catch (e) {
    console.error("ERROR:", e); res.status(500).send({ message: "Server error" });
  }
});

if (process.env.VERCEL !== "1") {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

export default app; // Vercel er jonno