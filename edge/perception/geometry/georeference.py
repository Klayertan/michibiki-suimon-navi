import math
EARTH_RADIUS_M=6378137.
def local_ned_to_lat_lon(latitude,longitude,north_m,east_m):
 return latitude+math.degrees(north_m/EARTH_RADIUS_M),longitude+math.degrees(east_m/(EARTH_RADIUS_M*math.cos(math.radians(latitude))))
