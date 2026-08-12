
// Static event catalogue for the demo platform.

// In a real system this would live in the database.

const EVENTS = [

  { eventId: 'evt-1001', name: 'DevSecOps Bootcamp', city: 'Zagreb', date: '2026-10-12' },

  { eventId: 'evt-1002', name: 'Cloud Native Day', city: 'Split', date: '2026-10-20' },

  { eventId: 'evt-1003', name: 'Security Engineering Meetup', city: 'Rijeka', date: '2026-11-03' },

];



function isValidEvent(eventId) {

  return EVENTS.some((e) => e.eventId === eventId);

}



module.exports = { EVENTS, isValidEvent };

