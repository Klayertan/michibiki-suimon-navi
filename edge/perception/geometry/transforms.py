"""Active extrinsic source→destination rotations, composed yaw-pitch-roll.

Body is Pixhawk/ArduPilot FRD (+X forward,+Y right,+Z down). Navigation is
NED (+X north,+Y east,+Z down). Camera optical is RealSense (+X image right,
+Y image down,+Z forward). Mount angles explicitly define optical→body.
"""
import math,numpy as np
def rotation_matrix_rpy_deg(roll,pitch,yaw):
 r,p,y=map(math.radians,(roll,pitch,yaw));cr,sr=math.cos(r),math.sin(r);cp,sp=math.cos(p),math.sin(p);cy,sy=math.cos(y),math.sin(y)
 return np.array([[cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr],[sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr],[-sp,cp*sr,cp*cr]])
def camera_to_body(camera_xyz,translation_m,rotation_deg):return rotation_matrix_rpy_deg(*rotation_deg)@np.asarray(camera_xyz,dtype=float)+np.asarray(translation_m,dtype=float)
def body_to_local_ned(body_xyz,roll_deg,pitch_deg,yaw_deg):return rotation_matrix_rpy_deg(roll_deg,pitch_deg,yaw_deg)@np.asarray(body_xyz,dtype=float)
