export const MILLISECONDS_IN_SECOND = 1000;
export const SECONDS_IN_MINUTE = 60;

export function getRandomNumber(min: number, max: number) {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function getRandomTimeInMinutes(min: number, max: number) {
  return (
    (Math.floor(Math.random() * (max - min)) + min) *
    MILLISECONDS_IN_SECOND *
    SECONDS_IN_MINUTE
  );
}
