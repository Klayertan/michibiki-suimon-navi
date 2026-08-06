"""MAVLink link layer.

Importing this package must never open a serial port or start a thread.
``real_connection`` imports :mod:`pymavlink` lazily inside its ``open()`` so
that the backend can run, and its tests can run, on a machine with no serial
hardware and no pymavlink installed.
"""
