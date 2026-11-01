'use strict';

const mongoose = require('mongoose');
const { CATEGORIES } = require('./User');

const VenueSchema = new mongoose.Schema(
  {
    venueId: { type: String, required: true },
    destination: { type: String, required: true, index: true },
    destinationSlug: { type: String, required: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    pricePerPersonCents: { type: Number, required: true, min: 0 },
    dietaryTags: [{ type: String }],
    hours: {
      open: { type: String, required: true },
      close: { type: String, required: true },
    },
    closedDays: [{ type: Number, min: 0, max: 6 }],
    coordinates: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    rating: { type: Number, min: 0, max: 5, default: 4 },
    popularity: { type: Number, min: 0, max: 100, default: 50 },
    description: { type: String, required: true, maxlength: 1000 },
    tags: [{ type: String }],
    transit: { type: String, default: '' },
    weatherNote: { type: String, default: '' },
    lodging: {
      sleeps: { type: Number, default: 0 },
      bedrooms: { type: Number, default: 0 },
    },
    datasetVersion: { type: String, default: '1.0.0' },
    uploadedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

VenueSchema.index({ destinationSlug: 1, venueId: 1 }, { unique: true });
VenueSchema.index({ destinationSlug: 1, category: 1 });
VenueSchema.index({ destinationSlug: 1, 'coordinates.lat': 1, 'coordinates.lng': 1 });

VenueSchema.methods.toPublicJSON = function toPublicJSON() {
  const obj = this.toObject({ virtuals: false });
  delete obj._id;
  delete obj.__v;
  delete obj.uploadedByUserId;
  return {
    venueId: obj.venueId,
    destination: obj.destination,
    name: obj.name,
    category: obj.category,
    pricePerPerson: obj.pricePerPersonCents / 100,
    pricePerPersonCents: obj.pricePerPersonCents,
    dietaryTags: obj.dietaryTags,
    hours: obj.hours,
    coordinates: { lat: obj.coordinates.lat, lng: obj.coordinates.lng },
    rating: obj.rating,
    popularity: obj.popularity,
    description: obj.description,
    tags: obj.tags,
    transit: obj.transit,
    weatherNote: obj.weatherNote,
    lodging: obj.lodging,
  };
};

module.exports = mongoose.model('Venue', VenueSchema);
