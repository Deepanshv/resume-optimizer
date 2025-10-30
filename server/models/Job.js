const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
  clientName: {
    type: String,
    required: true,
  },
  companyName: {
    type: String,
    required: true,
  },
  position: {
    type: String,
    required: true,
  },
  jobDescription: {
    type: String,
    required: true,
  },
  jobApplicationLink: {
    type: String,
  },
  status: {
    type: String,
    enum: ['Pending Optimization', 'Optimized'],
    default: 'Pending Optimization',
  },
  optimizedOn: {
    type: Date,
  },
  baseResume: {
    type: String, // Storing resume text directly
    required: true,
  },
  optimizedResume: {
    type: String, // Storing optimized resume text
  },
  changesSummary: {
    type: String, // Storing the summary of changes from the AI
  }
});

module.exports = mongoose.model('Job', JobSchema);
