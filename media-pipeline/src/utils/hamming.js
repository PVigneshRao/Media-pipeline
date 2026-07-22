/**
 * Hamming distance between two equal-length hex strings (perceptual hashes).
 * Lower distance = more visually similar images. A distance of 0 is a
 * pixel-identical (or near-identical) image; small distances (~<=5 for an
 * 8x8 phash) are commonly treated as "likely the same image".
 */
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;

  let distance = 0;
  for (let i = 0; i < hexA.length; i += 1) {
    const a = parseInt(hexA[i], 16);
    const b = parseInt(hexB[i], 16);
    let xor = a ^ b;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

module.exports = { hammingDistance };
