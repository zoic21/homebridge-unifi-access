/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * access-events.ts: Events class for UniFi Access.
 */
import { API, HAP, Service } from "homebridge";
import { AccessApi, AccessDeviceConfig, AccessEventPacket } from "unifi-access";
import { AccessLogging, AccessReservedNames } from "./access-types.js";
import { AccessController} from "./access-controller.js";
import { AccessDevice } from "./access-device.js";
import { AccessPlatform } from "./access-platform.js";
import { EventEmitter } from "node:events";

export class AccessEvents extends EventEmitter {

  private api: API;
  private controller: AccessController;
  private eventsHandler: ((packet: AccessEventPacket) => void) | null;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private hap: HAP;
  private log: AccessLogging;
  private mqttPublishTelemetry: boolean;
  private platform: AccessPlatform;
  private udaApi: AccessApi;
  private udaDeviceState: { [index: string]: AccessDeviceConfig };
  private udaUpdatesHandler:  ((packet: AccessEventPacket) => void) | null;
  private unsupportedDevices: { [index: string]: boolean };

  // Initialize an instance of our Access events handler.
  constructor(controller: AccessController) {

    super();

    this.api = controller.platform.api;
    this.eventTimers = {};
    this.hap = controller.platform.api.hap;
    this.log = controller.log;
    this.mqttPublishTelemetry = controller.hasFeature("Controller.Publish.Telemetry");
    this.controller = controller;
    this.udaApi = controller.udaApi;
    this.udaDeviceState = {};
    this.platform = controller.platform;
    this.unsupportedDevices = {};
    this.eventsHandler = null;
    this.udaUpdatesHandler = null;

    // If we've enabled telemetry from the controller inform the user.
    if(this.mqttPublishTelemetry) {

      this.log.info("Access controller telemetry enabled.");
    }

    this.configureEvents();
  }

  // Process Access API update events.
  private udaUpdates(packet: AccessEventPacket): void {

    let accessDevice: AccessDevice | null;

    switch((packet.data as AccessDeviceConfig).device_type) {

      case "UAH":
      default:

        // Lookup the device.
        accessDevice = this.controller.deviceLookup(packet.event_object_id);

        // No device found, we're done.
        if(!accessDevice) {

          break;
        }

        // Update our device configuration state.
        accessDevice.uda = packet.data as AccessDeviceConfig;

        // If we have services on the accessory associated with the Access device that have a StatusActive characteristic set, update our availability state.
        accessDevice.accessory.services.filter(x => x.testCharacteristic(this.hap.Characteristic.StatusActive))
          ?.map(x => x.updateCharacteristic(this.hap.Characteristic.StatusActive, accessDevice?.uda.is_online === true));

        // Sync names, if configured to do so.
        if(accessDevice.hints.syncName && accessDevice.name !== accessDevice.uda.name) {

          accessDevice.log.info("Name change detected. A restart of Homebridge may be needed in order to complete name synchronization with HomeKit.");
          accessDevice.configureInfo();
        }

        break;
    }

    // Update the internal list we maintain.
    this.udaDeviceState[packet.event_object_id] = packet.data as AccessDeviceConfig;
  }

  // Process device additions and removals from the Access events API.
  private manageDevices(packet: AccessEventPacket): void {

    // Lookup the device.
    const accessDevice = this.controller.deviceLookup(packet.event_object_id);

    // We're unadopting.
    if(packet.event === "access.data.device.delete") {

      // If it's already gone, we're done.
      if(!accessDevice) {

        return;
      }

      // Remove the device.
      this.controller.removeHomeKitDevice(accessDevice);
      return;
    }
  }

  // Listen to the UniFi Access events API for updates we are interested in (e.g. unlock).
  private configureEvents(): boolean {

    // Only configure the event listener if it exists and it's not already configured.
    if(this.eventsHandler && this.udaUpdatesHandler) {

      return true;
    }

    // Ensure we update our UDA state before we process any other events.
    this.prependListener("access.data.device.update", this.udaUpdatesHandler = this.udaUpdates.bind(this));

    // Process remove events.
    this.prependListener("access.data.device.delete", this.manageDevices.bind(this));

    // Listen for any messages coming in from our listener. We route events to the appropriate handlers based on the type of event that comes across.
    this.udaApi.on("message", this.eventsHandler = (packet: AccessEventPacket): void => {

      // Emit messages based on the event type.
      this.emit(packet.event, packet);

      // Emit messages based on the specific device.
      this.emit(packet.event_object_id, packet);

      // Finally, emit messages based on the specific event and device combination.
      this.emit(packet.event + "." + packet.event_object_id, packet);

      // If enabled, publish all the event traffic coming from the Access controller to MQTT.
      if(this.mqttPublishTelemetry) {

        this.controller.mqtt?.publish(this.controller.uda.host.mac, "telemetry", JSON.stringify(packet));
      }
    });

    return true;
  }

  // Motion event processing from UniFi Access.
  public motionEventHandler(accessDevice: AccessDevice): void {

    if(!accessDevice) {

      return;
    }

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = accessDevice.accessory.getService(this.hap.Service.MotionSensor);

    if(motionService) {

      this.motionEventDelivery(accessDevice, motionService);
    }
  }

  // Motion event delivery to HomeKit.
  private motionEventDelivery(accessDevice: AccessDevice, motionService: Service): void {

    if(!accessDevice) {

      return;
    }

    // If we have disabled motion events, we're done here.
    if(("detectMotion" in accessDevice.accessory.context) && !accessDevice.accessory.context.detectMotion) {

      return;
    }

    // If we have an active motion event inflight, we're done.
    if(this.eventTimers[accessDevice.id]) {

      return;
    }

    // Trigger the motion event in HomeKit.
    motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

    // If we have a motion trigger switch configured, update it.
    accessDevice.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_MOTION_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, true);

    // Publish the motion event to MQTT, if the user has configured it.
    this.controller.mqtt?.publish(accessDevice.accessory, "motion", "true");

    // Log the event, if configured to do so.
    if(accessDevice.hints.logMotion) {

      accessDevice.log.info("Motion detected.");
    }

    // Reset our motion event after motionDuration.
    this.eventTimers[accessDevice.id] = setTimeout(() => {

      motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

      // If we have a motion trigger switch configured, update it.
      accessDevice.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_MOTION_TRIGGER)?.updateCharacteristic(this.hap.Characteristic.On, false);

      accessDevice.log.debug("Resetting motion event.");

      // Publish to MQTT, if the user has configured it.
      this.controller.mqtt?.publish(accessDevice.accessory, "motion", "false");

      // Delete the timer from our motion event tracker.
      delete this.eventTimers[accessDevice.id];
    }, accessDevice.hints.motionDuration * 1000);
  }

/*
  // Doorbell event processing from UniFi Access and delivered to HomeKit.
  public doorbellEventHandler(accessDevice: AccessDevice, lastRing: number | null): void {

    if(!accessDevice || !lastRing) {

      return;
    }

    // If we have an inflight ring event, and we're enforcing a ring duration, we're done.
    if(this.eventTimers[accessDevice.id + ".Doorbell.Ring"]) {

      return;
    }

    // Only notify the user if we have a doorbell.
    const doorbellService = accessDevice.accessory.getService(this.hap.Service.Doorbell);

    if(!doorbellService) {

      return;
    }

    // Trigger the doorbell event in HomeKit.
    doorbellService.getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      ?.sendEventNotification(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Check to see if we have a doorbell trigger switch configured. If we do, update it.
    const triggerService = accessDevice.accessory.getServiceById(this.hap.Service.Switch, AccessReservedNames.SWITCH_DOORBELL_TRIGGER);

    if(triggerService) {

      // Kill any inflight trigger reset.
      if(this.eventTimers[accessDevice.id + ".Doorbell.Ring.Trigger"]) {

        clearTimeout(this.eventTimers[accessDevice.id + ".Doorbell.Ring.Trigger"]);
        delete this.eventTimers[accessDevice.id + ".Doorbell.Ring.Trigger"];
      }

      // Flag that we're ringing.
      accessDevice.isRinging = true;

      // Update the trigger switch state.
      triggerService.updateCharacteristic(this.hap.Characteristic.On, true);

      // Reset our doorbell trigger.
      this.eventTimers[accessDevice.id + ".Doorbell.Ring.Trigger"] = setTimeout(() => {

        accessDevice.isRinging = false;

        triggerService.updateCharacteristic(this.hap.Characteristic.On, false);
        this.log.debug("Resetting doorbell ring trigger.");

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[accessDevice.id + ".Doorbell.Ring.Trigger"];
      }, ACCESS_DOORBELL_TRIGGER_DURATION);
    }

    // Publish to MQTT, if the user has configured it.
    this.controller.mqtt?.publish(accessDevice.accessory, "doorbell", "true");

    if(accessDevice.hints.logDoorbell) {

      accessDevice.log.info("Doorbell ring detected.");
    }

    // Kill any inflight MQTT reset.
    if(this.eventTimers[accessDevice.id + ".Doorbell.Ring.MQTT"]) {

      clearTimeout(this.eventTimers[accessDevice.id + ".Doorbell.Ring.MQTT"]);
      delete this.eventTimers[accessDevice.id + ".Doorbell.Ring.MQTT"];
    }

    // Fire off our MQTT doorbell ring event.
    this.eventTimers[accessDevice.id + ".Doorbell.Ring.MQTT"] = setTimeout(() => {

      this.controller.mqtt?.publish(accessDevice.accessory, "doorbell", "false");

      // Delete the timer from our event tracker.
      delete this.eventTimers[accessDevice.id + ".Doorbell.Ring.MQTT"];
    }, ACCESS_DOORBELL_TRIGGER_DURATION);

    // If we don't have a ring duration defined, we're done.
    if(!this.controller.platform.config.ringDelay) {

      return;
    }

    // Reset our ring threshold.
    this.eventTimers[accessDevice.id + ".Doorbell.Ring"] = setTimeout(() => {

      // Delete the timer from our event tracker.
      delete this.eventTimers[accessDevice.id + ".Doorbell.Ring"];
    }, this.controller.platform.config.ringDelay * 1000);
  }
/* */
}
