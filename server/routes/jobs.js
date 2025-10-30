const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Job = require("../models/Job");
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");

// @route   GET api/jobs
// @desc    Get all jobs
// @access  Public
router.get("/", async (req, res) => {
  try {
    // Debug log
    console.log(
      "GET /api/jobs - Checking MongoDB connection state:",
      mongoose.connection.readyState
    );

    // Check MongoDB connection state with retry
    if (mongoose.connection.readyState !== 1) {
      console.log("MongoDB not connected. Waiting for connection...");

      try {
        // Wait for up to 5 seconds for the connection to be established
        await new Promise((resolve, reject) => {
          let retries = 0;
          const checkConnection = setInterval(() => {
            if (mongoose.connection.readyState === 1) {
              clearInterval(checkConnection);
              resolve();
            } else if (retries >= 5) {
              clearInterval(checkConnection);
              reject(new Error("Connection timeout"));
            }
            retries++;
          }, 1000);
        });
      } catch (timeoutError) {
        console.log("Connection timeout. Current state:", {
          readyState: mongoose.connection.readyState,
          host: mongoose.connection.host,
          name: mongoose.connection.name,
        });

        return res.status(503).json({
          success: false,
          error: "Database unavailable",
          message: "Database connection is not ready. Please refresh the page.",
          details:
            process.env.NODE_ENV === "development"
              ? {
                  state: mongoose.connection.readyState,
                  host: mongoose.connection.host,
                }
              : undefined,
          jobs: [],
        });
      }
    }

    // Debug log
    console.log("MongoDB connected, executing find() query");

    const jobs = await Job.find().sort({ optimizedOn: -1 }).exec();

    // Debug log
    console.log(`Query complete. Found ${jobs.length} jobs`);

    res.json({
      success: true,
      jobs: jobs || [],
    });
  } catch (err) {
    console.error("Error in /api/jobs:", err);
    console.error("Error stack:", err.stack);

    // Send detailed error in development, sanitized in production
    res.status(500).json({
      success: false,
      error: "Server Error",
      message:
        process.env.NODE_ENV === "development"
          ? `Failed to fetch jobs: ${err.message}`
          : "Failed to fetch jobs. Please try again later.",
      details:
        process.env.NODE_ENV === "development"
          ? {
              name: err.name,
              code: err.code,
              stack: err.stack,
            }
          : undefined,
      jobs: [],
    });
  }
});

// @route   POST api/jobs
// @desc    Create a job
// @access  Public
router.post("/", async (req, res) => {
  const {
    clientName,
    companyName,
    position,
    jobDescription,
    jobApplicationLink,
    baseResume,
  } = req.body;

  try {
    const newJob = new Job({
      clientName,
      companyName,
      position,
      jobDescription,
      jobApplicationLink,
      baseResume,
    });

    const job = await newJob.save();
    res.json(job);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// @route   PUT api/jobs/:id
// @desc    Update a job
// @access  Public
router.put("/:id", async (req, res) => {
  const {
    clientName,
    companyName,
    position,
    jobDescription,
    jobApplicationLink,
    status,
  } = req.body;

  // Build job object
  const jobFields = {};
  if (clientName) jobFields.clientName = clientName;
  if (companyName) jobFields.companyName = companyName;
  if (position) jobFields.position = position;
  if (jobDescription) jobFields.jobDescription = jobDescription;
  if (jobApplicationLink) jobFields.jobApplicationLink = jobApplicationLink;
  if (status) jobFields.status = status;

  try {
    let job = await Job.findById(req.params.id);

    if (!job) return res.status(404).json({ msg: "Job not found" });

    job = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: jobFields },
      { new: true }
    );

    res.json(job);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// @route   DELETE api/jobs/:id
// @desc    Delete a job
// @access  Public
router.delete("/:id", async (req, res) => {
  try {
    let job = await Job.findById(req.params.id);

    if (!job) return res.status(404).json({ msg: "Job not found" });

    await Job.findByIdAndDelete(req.params.id);

    res.json({ msg: "Job removed" });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
});

// @route   POST api/jobs/:id/optimize
// @desc    Optimize a resume for a job
// @access  Public
router.post("/:id/optimize", async (req, res) => {
  try {
    let job = await Job.findById(req.params.id);

    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        message: "The requested job could not be found.",
      });
    }

    // Validate required fields
    if (!job.baseResume || !job.jobDescription) {
      return res.status(400).json({
        error: "Missing required data",
        message: "Resume and job description are required for optimization.",
        details: {
          hasBaseResume: !!job.baseResume,
          hasJobDescription: !!job.jobDescription,
        },
      });
    }

    try {
      console.log("Starting optimization for job:", {
        id: job._id,
        position: job.position,
        hasBaseResume: !!job.baseResume,
        hasJobDescription: !!job.jobDescription,
      });

      // Call the AI service
      const result = await optimizeResumeWithAI(
        job.baseResume,
        job.jobDescription
      );

      // If optimization failed, return error without saving
      if (!result.optimizedResume || result.error) {
        return res.status(400).json({
          error: result.error || "Optimization failed",
          message: result.changesSummary || "Could not optimize resume.",
        });
      }

      // Only save if we got valid optimization results
      job.optimizedResume = result.optimizedResume;
      job.changesSummary = result.changesSummary;
      job.status = "Optimized";
      job.optimizedOn = Date.now();

      await job.save();
      res.json(job);
    } catch (optimizeError) {
      // Handle optimization-specific errors
      console.error("Optimization error:", optimizeError);
      return res.status(400).json({
        error: "Optimization failed",
        message: optimizeError.message,
      });
    }
  } catch (err) {
    // Handle server/database errors
    console.error("Server error:", err);
    res.status(500).json({
      error: "Server Error",
      message: "An unexpected error occurred while processing your request.",
    });
  }
});

// --- Real AI Function ---
const optimizeResumeWithAI = async (baseResume, jobDescription) => {
  // Validate inputs
  if (!baseResume || !jobDescription) {
    throw new Error("Resume and job description are required");
  }

  try {
    // Check API key
    if (!process.env.GEMINI_API_KEY) {
      console.error("Gemini API key is missing in environment variables");
      return {
        error: "Configuration Error",
        changesSummary:
          "The AI service is not properly configured. Please contact support.",
        optimizedResume: null,
      };
    }

    // Validate input lengths
    if (baseResume.length < 10) {
      return {
        error: "Invalid Input",
        changesSummary:
          "The provided resume is too short. Please provide a more detailed resume.",
        optimizedResume: null,
      };
    }

    if (jobDescription.length < 10) {
      return {
        error: "Invalid Input",
        changesSummary:
          "The job description is too short. Please provide a more detailed job description.",
        optimizedResume: null,
      };
    }

    console.log("Initializing Gemini AI for resume optimization");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // For v1beta API, use correct model names
    // Configure the model with appropriate settings for resume optimization
    const modelConfig = {
      model: "gemini-1.5-flash-latest",
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    };

    console.log("Initializing Gemini model with config:", modelConfig);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    const prompt = `You are an expert resume optimizer AI. Your task is to optimize a resume to match a job description perfectly.

Instructions:
1. Carefully analyze both the resume and job description
2. Identify key skills and requirements from the job description
3. Modify the resume to:
   - Highlight matching skills and experiences
   - Add relevant keywords from the job description
   - Improve formatting and clarity
   - Quantify achievements where possible
4. Create a bullet-point summary of changes made

Provide the output in this EXACT JSON format:
{
  "optimizedResume": "The complete optimized resume with proper formatting",
  "changesSummary": "• Change 1: What was modified and why\n• Change 2: Another modification and reasoning\n• Change 3: Additional changes made"
}

Resume to Optimize:
${baseResume}

Job Description to Target:
${jobDescription}

Remember: Ensure output is valid JSON and maintain professional formatting in the optimized resume.`;

    console.log("Sending prompt to Gemini AI");

    // Generate content
    let result;
    try {
      result = await model.generateContent({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
      });
      if (!result || !result.response) {
        throw new Error("No response from Gemini API");
      }
      result = result.response;
    } catch (err) {
      console.error("Error generating content:", err);
      throw err;
    }

    const text = await result.text();
    console.log("Raw response from Gemini AI:", text);

    try {
      // Parse the response as JSON
      let cleanedText = text
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      // Additional cleaning to ensure valid JSON
      if (!cleanedText.startsWith("{")) {
        cleanedText = cleanedText.substring(cleanedText.indexOf("{"));
      }
      if (!cleanedText.endsWith("}")) {
        cleanedText = cleanedText.substring(
          0,
          cleanedText.lastIndexOf("}") + 1
        );
      }

      try {
        const parsed = JSON.parse(cleanedText);

        // Comprehensive validation of the AI response
        if (!parsed || typeof parsed !== "object") {
          console.error("Invalid JSON structure received from AI");
          return {
            error: "Invalid Response Format",
            changesSummary:
              "The AI provided an invalid response structure. Please try again.",
            optimizedResume: null,
          };
        }

        if (
          !parsed.optimizedResume ||
          typeof parsed.optimizedResume !== "string"
        ) {
          console.error("Missing or invalid optimizedResume in AI response");
          return {
            error: "Invalid Resume Format",
            changesSummary:
              "The optimized resume format was invalid. Please try again.",
            optimizedResume: null,
          };
        }

        if (
          !parsed.changesSummary ||
          typeof parsed.changesSummary !== "string"
        ) {
          console.error("Missing or invalid changesSummary in AI response");
          return {
            error: "Invalid Changes Summary",
            changesSummary:
              "The changes summary was not provided. Please try again.",
            optimizedResume: null,
          };
        }

        // Validate content length and quality
        if (parsed.optimizedResume.length < 100) {
          console.error(
            "Optimized resume too short:",
            parsed.optimizedResume.length
          );
          return {
            error: "Invalid Content Length",
            changesSummary:
              "The generated resume is too short. Please try again.",
            optimizedResume: null,
          };
        }

        if (parsed.changesSummary.length < 20) {
          console.error(
            "Changes summary too short:",
            parsed.changesSummary.length
          );
          return {
            error: "Invalid Summary Length",
            changesSummary:
              "The changes summary is too brief. Please try again.",
            optimizedResume: null,
          };
        }

        // If all validations pass, return the parsed response
        return parsed;
      } catch (parseError) {
        console.error("Failed to parse AI response:", parseError);
        return {
          error: "Processing Error",
          changesSummary:
            "Failed to process the AI response. Please try again.",
          optimizedResume: null,
        };
      }
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      return {
        error: "Processing Error",
        changesSummary: "Failed to process the AI response. Please try again.",
        optimizedResume: null,
      };
    }
  } catch (geminiError) {
    console.error("Error in Gemini API call:", geminiError);
    return {
      error: "AI Service Error",
      changesSummary:
        geminiError.message ||
        "An error occurred while optimizing the resume. Please try again.",
      optimizedResume: null,
    };
  }

  // If we get here, something went wrong with the Gemini API
  return {
    error: "AI Service Error",
    changesSummary:
      "Could not optimize resume due to an AI service error. Please try again.",
    optimizedResume: null,
  };
};

module.exports = router;
