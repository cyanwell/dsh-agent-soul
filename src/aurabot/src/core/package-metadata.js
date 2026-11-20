export function createPackageMetadataGetter({ path, readFile }) {
  if (typeof path !== 'string' || typeof readFile !== 'function') throw new TypeError('path and readFile are required')
  let loaded = false
  let metadata
  return function getPackageMetadata() {
    if (!loaded) {
      loaded = true
      try { metadata = JSON.parse(readFile(path, 'utf8')) } catch (error) { metadata = { version: '?' } }
    }
    return metadata
  }
}

