const mongoose = require("mongoose");

// Global configuration for Mongoose
mongoose.set("strictQuery", false);

const MAX_RETRIES = 5;
const RETRY_INTERVAL = 2000; // 2 seconds

const connectWithRetry = async (uri, options, retryCount = 0) => {
  try {
    await mongoose.connect(uri, options);
    return true;
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      console.log(
        `Connection attempt ${retryCount + 1} failed. Retrying in ${
          RETRY_INTERVAL / 1000
        } seconds...`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
      return connectWithRetry(uri, options, retryCount + 1);
    }
    throw error;
  }
};

const connectDB = async () => {
  console.log("Connecting to MongoDB...");

  const commonOptions = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    keepAlive: true,
    retryWrites: true,
  };

  try {
    // Try connecting to MongoDB Atlas first
    try {
      await connectWithRetry(process.env.MONGO_URI, commonOptions);
      console.log("Successfully connected to MongoDB Atlas");
      return;
    } catch (atlasError) {
      console.log(
        "Could not connect to MongoDB Atlas, trying local fallback..."
      );

      // If Atlas fails, try connecting to local MongoDB
      await connectWithRetry(
        "mongodb://127.0.0.1:27017/resume-optimizer",
        commonOptions
      );
      console.log("Successfully connected to local MongoDB");
    }
  } catch (err) {
    console.error("MongoDB Connection Error:", err.message);
    if (err.name === "MongoServerSelectionError") {
      console.error(
        "Could not connect to any MongoDB instance (Atlas or local)"
      );
      console.error("Please ensure either:");
      console.error("1. Your MongoDB Atlas IP whitelist is configured");
      console.error("2. Or you have MongoDB running locally");
    }
    throw err;
  }
};

let isConnecting = false;

mongoose.connection.on("connected", () => {
  console.log("MongoDB Connected Successfully");
  isConnecting = false;
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB Connection Error:", err.message);
  if (!isConnecting) {
    isConnecting = true;
    console.log("Attempting to reconnect...");
    connectDB().catch((err) => {
      console.error("Reconnection failed:", err.message);
      isConnecting = false;
    });
  }
});

mongoose.connection.on("disconnected", () => {
  console.log("MongoDB Disconnected. Attempting to reconnect...");
  if (!isConnecting) {
    isConnecting = true;
    setTimeout(() => {
      connectDB().catch((err) => {
        console.error("Reconnection failed:", err.message);
        isConnecting = false;
      });
    }, 2000);
  }
});

process.on("SIGINT", async () => {
  try {
    await mongoose.connection.close();
    console.log("MongoDB connection closed through app termination");
    process.exit(0);
  } catch (err) {
    console.error("Error closing MongoDB connection:", err);
    process.exit(1);
  }
});

module.exports = connectDB;
