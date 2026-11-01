'use strict';

const mongoose = require('mongoose');

const ReactionSchema = new mongoose.Schema(
  {
    emoji: { type: String, required: true, maxlength: 8 },
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { _id: false }
);

const ChatMessageSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    authorName: { type: String, default: 'System' },
    // chat | ai_answer | system | conflict
    msgType: { type: String, enum: ['chat', 'ai_answer', 'system', 'conflict'], default: 'chat' },
    body: { type: String, required: true, maxlength: 2000 },
    reactions: { type: [ReactionSchema], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    tsSeconds: { type: Number, default: () => Math.floor(Date.now() / 1000) },
  },
  { timestamps: true }
);

ChatMessageSchema.index({ tripId: 1, createdAt: -1 });

ChatMessageSchema.methods.toPublicJSON = function toPublicJSON() {
  const obj = this.toObject({ virtuals: false });
  obj.messageId = String(this._id);
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
