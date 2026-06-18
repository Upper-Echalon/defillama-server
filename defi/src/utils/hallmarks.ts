const hackHallmarkKeywords = ["hack", "exploit", "rug", "attack", "stolen", "theft", "drain"];

export function isHackHallmarkLabel(label: any) {
  if (typeof label !== "string") return false;
  const lowerLabel = label.toLowerCase();
  for (const keyword of hackHallmarkKeywords) {
    if (lowerLabel.includes(keyword)) return true;
  }
  return false;
}

export function isDuplicateHackHallmark(hallmark: any, hackTimestamps: any) {
  if (!Array.isArray(hallmark) || Array.isArray(hallmark[0])) return false;
  return hackTimestamps[hallmark[0]] === true && isHackHallmarkLabel(hallmark[1]);
}
