// Course playback: a course (a FIT course file, or the course points inside the ride's own FIT file)
// followed along the ride, for the Activity.Info navigation fields (nameOfNextPoint, distanceToNextPoint,
// nameOfDestination, distanceToDestination, elevationAtNextPoint, elevationAtDestination, offCourseDistance).
//
// The rider's position is matched to the course track (nearest segment, searched forward from the last
// match, so a course that passes the same place twice is followed in order). The distance along the course
// then picks the next course point. An approximation of the Edge's own navigation: see the README.

const SEMI = 180 / 2147483648;
const MATCH_M = 100;     // farther from the track than this = off course (the position along stays)
const WINDOW = 300;      // records searched ahead of the last match before searching the whole rest
const BACK = 20;         // records searched behind the last match
const END_M = 30;        // this close to the end, the course is done

// file_id type 6 = course
export function isCourseFit(fit) {
    return fit.messages.some(m => m.num === 0 && m.fields[0] === 6);
}

// Null when the FIT file has no course points or no track to put them on.
export function buildCourse(fit, fileName = '') {
    const track = [];
    const raw = [];
    let name = null;
    for (const m of fit.messages) {
        const f = m.fields;
        if (m.num === 20 && f[0] != null && f[1] != null) {
            const alt = f[78] != null ? f[78] / 5 - 500 : (f[2] != null ? f[2] / 5 - 500 : null);
            track.push({ lat: f[0] * SEMI, lon: f[1] * SEMI, dist: f[5] != null ? f[5] / 100 : null, alt });
        }
        // course_point: 2 position_lat, 3 position_long, 4 distance, 5 type, 6 name
        if (m.num === 32) raw.push({ name: f[6] ?? '', type: f[5] ?? null, lat: f[2] != null ? f[2] * SEMI : null,
            lon: f[3] != null ? f[3] * SEMI : null, dist: f[4] != null ? f[4] / 100 : null });
        // course: 5 name
        if (m.num === 31 && f[5] != null) name = f[5];
    }
    if (track.length < 2 || raw.length === 0) return null;

    // Distances along the track: the file's own, else measured
    if (track.some(r => r.dist == null)) {
        track[0].dist = 0;
        for (let i = 1; i < track.length; i++) track[i].dist = track[i - 1].dist + haversine(track[i - 1], track[i]);
    }
    let lastAlt = null;
    for (const r of track) { if (r.alt == null) r.alt = lastAlt; else lastAlt = r.alt; }
    const course = { name: name ?? fileName.replace(/\.fit$/i, ''), track, total: track[track.length - 1].dist, points: [] };
    for (const p of raw) {
        let dist = p.dist;
        if (dist == null && p.lat != null) dist = match(course, p, 0, track.length - 2)?.along ?? null;
        if (dist == null) continue;
        course.points.push({ name: p.name, type: p.type, dist, alt: altAt(course, dist) });
    }
    course.points.sort((a, b) => a.dist - b.dist);
    return course.points.length ? course : null;
}

// Adds s.course to every second of the ride: what the Edge would report while navigating the course.
export function applyCourse(ride, course) {
    let j = null; // index of the last matched segment
    let last = null;
    let done = false; // the destination reached: the Edge ends the course
    for (const s of ride.secs) {
        if (!course || done) { s.course = null; continue; }
        if (s.lat != null) {
            const here = { lat: s.lat, lon: s.lon };
            let m = null;
            if (j == null) m = match(course, here, 0, course.track.length - 2);
            else {
                m = match(course, here, Math.max(0, j - BACK), Math.min(course.track.length - 2, j + WINDOW));
                if (!m || m.off > MATCH_M) {
                    const far = match(course, here, j, course.track.length - 2);
                    if (far && (!m || far.off < m.off)) m = far;
                }
            }
            if (m && m.off <= MATCH_M) { j = m.i; last = { along: m.along, off: m.off }; }
            else if (m) last = { along: last ? last.along : 0, off: m.off }; // off course, or not on it yet
        }
        s.course = last ? state(course, last.along, last.off) : null;
        if (last && last.off <= MATCH_M && course.total - last.along < END_M) done = true;
    }
}

function state(course, along, off) {
    const next = course.points.find(p => p.dist > along + 0.5) || null;
    return {
        nextName: next ? next.name : null,
        nextDist: next ? next.dist - along : null,
        nextAlt: next ? next.alt : null,
        destName: course.name,
        destDist: Math.max(0, course.total - along),
        destAlt: course.track[course.track.length - 1].alt,
        off,
    };
}

// Nearest track segment from index a to b (segment i = record i to i+1): {i, along, off} or null.
function match(course, p, a, b) {
    const t = course.track;
    const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
    let best = null;
    for (let i = a; i <= b; i++) {
        const r0 = t[i], r1 = t[i + 1];
        const x0 = (r0.lon - p.lon) * kx, y0 = (r0.lat - p.lat) * ky;
        const dx = (r1.lon - r0.lon) * kx, dy = (r1.lat - r0.lat) * ky;
        const len2 = dx * dx + dy * dy;
        const u = len2 > 0 ? Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / len2)) : 0;
        const off = Math.hypot(x0 + u * dx, y0 + u * dy);
        if (!best || off < best.off - 0.01) best = { i, off, along: r0.dist + u * (r1.dist - r0.dist) };
    }
    return best;
}

function altAt(course, dist) {
    const t = course.track;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid].dist <= dist) lo = mid; else hi = mid; }
    return t[lo].alt;
}

function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
