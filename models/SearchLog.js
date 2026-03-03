const mongoose = require('mongoose');

/**
 * SearchLog: one document per search event.
 * createdAt (auto-added by timestamps) is used for 30-day window aggregation.
 */
const searchLogSchema = new mongoose.Schema(
    {
        query: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
            maxlength: 200,
        },
    },
    { timestamps: true } // adds createdAt & updatedAt
);

// Index for fast 30-day range queries
searchLogSchema.index({ createdAt: -1 });
searchLogSchema.index({ query: 1, createdAt: -1 });

module.exports = mongoose.model('SearchLog', searchLogSchema);
