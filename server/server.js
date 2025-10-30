const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./db");

// Load env vars
dotenv.config();

const app = express();

// Body parser with size limit
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Enable CORS
app.use(cors());

// Add request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  console.error("Stack:", err.stack);
  res.status(500).json({
    success: false,
    error: "Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "An error occurred",
    details:
      process.env.NODE_ENV === "development"
        ? {
            name: err.name,
            stack: err.stack,
          }
        : undefined,
  });
});

// Error logging middleware
app.use((err, req, res, next) => {
  console.error("Express Error:", err);
  console.error("Stack:", err.stack);
  res.status(500).json({
    success: false,
    error: "Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

app.get("/", (req, res) => res.send("API Running"));

// Define Routes
app.use("/api/jobs", require("./routes/jobs"));

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Start the server first so API endpoints are available even if DB is down
    const server = app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
      console.log(`API available at http://localhost:${PORT}`);
    });

    // Then try to connect to MongoDB
    try {
      await connectDB();
      console.log("Successfully connected to MongoDB.");
    } catch (dbError) {
      console.error(
        "Warning: Failed to connect to MongoDB. API will run in limited mode."
      );
      console.error("Database Error:", dbError.message);
    }

    // Handle server shutdown
    process.on("SIGTERM", () => {
      console.log("SIGTERM received. Shutting down gracefully...");
      server.close(() => {
        console.log("HTTP server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
