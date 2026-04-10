const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
    token: {
        type: String,
        required: true,
        unique: true
    },
    platform: {
        type: String,
        enum: ['android', 'ios', 'web', 'unknown'],
        default: 'unknown'
    },
    lastActiveAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
