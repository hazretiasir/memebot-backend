const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        default: null,
    },
    tags: {
        type: [String],
        default: [],
    },
    s3Key: {
        type: String,
        required: true,
    },
    s3Url: {
        type: String,
        required: true,
    },
    thumbnailUrl: {
        type: String,
        default: null,
    },
    thumbnailKey: {
        type: String,
        default: null,
    },
    uploadedBy: {
        type: String,
        default: 'anonymous',
    },
    likes: {
        type: Number,
        default: 0,
    },
    dislikes: {
        type: Number,
        default: 0,
    },
    searchUpvotes: {
        type: Number,
        default: 0,
    },
    searchDownvotes: {
        type: Number,
        default: 0,
    },
    relevanceScore: {
        type: Number,
        default: 0,
    },
    downloadCount: {
        type: Number,
        default: 0,
    },
    viewCount: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    // 768-dimensional vector from Gemini text-embedding-004
    // Used for semantic / vector search via Atlas $vectorSearch
    embedding: {
        type: [Number],
        default: undefined, // omit field when not yet generated
    },

    // ─── Audio Transcription ─────────────────────────────────────────────────
    transcript: {
        type: String,
        default: '',       // empty string = processed but no speech
    },
    hasSpeech: {
        type: Boolean,
        default: null,     // null = not yet processed, true/false = result
    },
    // Unified search text: title + tags + description + transcript
    // This single field drives both full-text and vector search
    searchText: {
        type: String,
        default: '',
    },
});

// Full-text search index: now includes transcript and searchText
videoSchema.index({ title: 'text', description: 'text', tags: 'text', transcript: 'text', searchText: 'text' });
// Note: the vector search index must be created in Atlas UI (see README)


// ─── Relevance score formula ──────────────────────────────────────────────────
// Combines:
//   1. Wilson Score  — statistically correct lower bound of like ratio
//   2. Engagement    — log(views + downloads + 1)  (depth of interaction)
//   3. Time decay    — recently uploaded videos get a mild initial boost
videoSchema.methods.recalculateScore = function () {
    // 0. Logical Enforcer: A video must have been viewed at least as many times as it was interacted with
    const totalInteractions = this.likes + this.dislikes + this.searchUpvotes + this.searchDownvotes;
    if (this.viewCount < totalInteractions) {
        this.viewCount = totalInteractions;
    }

    const n = this.searchUpvotes + this.searchDownvotes;   // total SEARCH votes

    // 1. Wilson Score (95% confidence lower bound)
    let wilsonScore = 0;
    if (n > 0) {
        const z = 1.96;       // 95% confidence
        const p = this.searchUpvotes / n;
        const nf = n;
        wilsonScore = (
            p + (z * z) / (2 * nf)
            - z * Math.sqrt((p * (1 - p)) / nf + (z * z) / (4 * nf * nf))
        ) / (1 + (z * z) / nf);
    }

    // 2. Engagement boost — log scale so a video with 1000 views isn't 1000× better
    const engagement = Math.log1p(this.viewCount + this.downloadCount);

    // 3. Time decay — videos < 7 days old get up to +0.1 bonus, fades to 0
    const ageMs = Date.now() - (this.createdAt?.getTime() ?? Date.now());
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const newBonus = Math.max(0, 0.1 * (1 - ageDays / 7));

    // Final score (Wilson dominates; engagement and time are modifiers)
    this.relevanceScore = wilsonScore * (1 + 0.1 * engagement) + newBonus;
};


module.exports = mongoose.model('Video', videoSchema);
